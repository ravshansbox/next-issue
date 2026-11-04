import { setTimeout as delay } from 'node:timers/promises';
import { lines, must, run, type RunOptions, type RunResult } from './exec.mts';
import { isAncestor, type Repo } from './git.mts';
import { type Clock, type Polling, pause, pollUntil, REAL_CLOCK } from './poll.mts';

export type Issue = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: string[];
};

export type Kind = 'issue' | 'pr';

export type CheckState = 'pass' | 'fail' | 'pending' | 'none' | 'timeout' | 'moved';

const CHECK_PENDING_CODE = 8;
const READ_TRIES = 3;
const NETWORK_TRIES = 3;
const NETWORK_FAULT =
  /unexpected EOF|connection reset|connection refused|i\/o timeout|TLS handshake timeout|HTTP 50[234]/i;
const KNOWN_LABELS = new Map<string, Set<string>>();
const NO_CHECKS = /no checks reported/i;

type CheckSummary = { name: string; bucket: string; link: string; description: string };

type BaseRun = { databaseId: number; name: string; status: string; conclusion: string };

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

function slug(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

async function repeatable(repo: Repo, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await must('gh', args, { cwd: repo.root });
    } catch (error) {
      if (attempt >= NETWORK_TRIES || !networkFault(error)) {
        throw error;
      }
      await delay(attempt * 1000);
    }
  }
}

function networkFault(error: unknown): boolean {
  return error instanceof Error && NETWORK_FAULT.test(error.message);
}

function withRepo(repo: Repo, args: string[]): string[] {
  return [...args, '--repo', slug(repo)];
}

async function gh(repo: Repo, args: string[]): Promise<string> {
  return repeatable(repo, withRepo(repo, args));
}

async function ghJson<T>(repo: Repo, args: string[]): Promise<T> {
  return JSON.parse(await gh(repo, args)) as T;
}

async function ghOnce(repo: Repo, args: string[], input?: string): Promise<string> {
  return must('gh', withRepo(repo, args), { cwd: repo.root, input });
}

async function ghRun(repo: Repo, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run('gh', withRepo(repo, args), { ...options, cwd: repo.root });
}

async function ghApi(
  repo: Repo,
  path: string,
  jq: string,
  { paginate = false }: { paginate?: boolean } = {},
): Promise<string> {
  const pages = paginate ? ['--paginate'] : [];
  return repeatable(repo, ['api', ...pages, `repos/${slug(repo)}/${path}`, '--jq', jq]);
}

async function ghSucceeds(repo: Repo, args: string[]): Promise<boolean> {
  const result = await ghRun(repo, args);
  return result.code === 0;
}

export async function defaultBranch(repo: Repo): Promise<string> {
  const raw = await repeatable(repo, ['repo', 'view', slug(repo), '--json', 'defaultBranchRef']);
  return JSON.parse(raw).defaultBranchRef.name as string;
}

type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  labels: Array<{ name: string }>;
};

const ISSUE_FIELDS = 'number,title,body,createdAt,labels';

function names(items: Array<{ name: string }>): string[] {
  return items.map((item) => item.name);
}

function toIssue(item: RawIssue): Issue {
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    createdAt: item.createdAt,
    labels: names(item.labels),
  };
}

function labelFilter(labels: string[]): string {
  return labels.length === 0 ? '' : ` label:${labels.map((label) => `"${label}"`).join(',')}`;
}

export async function openIssues(repo: Repo, limit: number, labels: string[]): Promise<Issue[]> {
  const parsed = await ghJson<RawIssue[]>(repo, [
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `sort:created-asc${labelFilter(labels)}`,
    '--limit',
    String(limit),
    '--json',
    ISSUE_FIELDS,
  ]);
  return parsed.map(toIssue);
}

export async function viewIssue(repo: Repo, issue: number): Promise<Issue & { open: boolean }> {
  const parsed = await ghJson<RawIssue & { state: string }>(repo, [
    'issue',
    'view',
    String(issue),
    '--json',
    `${ISSUE_FIELDS},state`,
  ]);
  return { ...toIssue(parsed), open: parsed.state === 'OPEN' };
}

export type Comment = { author: string; body: string; url?: string };

export async function issueComments(repo: Repo, issue: number): Promise<Comment[]> {
  const parsed = await ghJson<{
    comments: Array<{ author: { login: string }; body: string }>;
  }>(repo, ['issue', 'view', String(issue), '--json', 'comments']);
  return parsed.comments.map((comment) => ({ author: comment.author.login, body: comment.body }));
}

export async function threadComments(repo: Repo, number: number): Promise<Comment[]> {
  const raw = await ghApi(
    repo,
    `issues/${number}/comments`,
    '.[] | [.user.login, .body, .html_url] | @json',
    { paginate: true },
  );
  return lines(raw).map((line) => parseComment(line, number));
}

function parseComment(line: string, number: number): Comment {
  let parsed: [string, string | null, string?];
  try {
    parsed = JSON.parse(line) as [string, string | null, string?];
  } catch {
    throw new Error(`gh gave a comment of #${number} that is not valid JSON: ${line}`);
  }
  const [author, body, url] = parsed;
  return url === undefined ? { author, body: body ?? '' } : { author, body: body ?? '', url };
}

export async function canWrite(repo: Repo, login: string): Promise<boolean> {
  try {
    const permission = await ghApi(repo, `collaborators/${login}/permission`, '.permission');
    return ['admin', 'write'].includes(permission);
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

export async function openBlockers(repo: Repo, issue: number): Promise<string[]> {
  const repoSlug = slug(repo);
  const raw = await ghApi(
    repo,
    `issues/${issue}/dependencies/blocked_by`,
    '.[] | select(.state == "open") | (.repository_url | split("/") | .[-2:] | join("/")) + "#" + (.number | tostring)',
    { paginate: true },
  );
  return lines(raw).map((ref) =>
    ref.startsWith(`${repoSlug}#`) ? ref.slice(repoSlug.length) : ref,
  );
}

async function labelsOf(repo: Repo, kind: Kind, number: number): Promise<string[]> {
  const parsed = await ghJson<{ labels: Array<{ name: string }> }>(repo, [
    kind,
    'view',
    String(number),
    '--json',
    'labels',
  ]);
  return names(parsed.labels);
}

export function labelArgs(add: string, remove: string[], current: string[]): string[] {
  const args = ['--add-label', add];
  for (const name of remove.filter((item) => item !== add && current.includes(item))) {
    args.push('--remove-label', name);
  }
  return args;
}

export async function setLabel(
  repo: Repo,
  kind: Kind,
  number: number,
  add: string,
  remove: string[],
): Promise<void> {
  await createUnknownLabel(repo, add);
  const current = await labelsOf(repo, kind, number);
  const args = [kind, 'edit', String(number), ...labelArgs(add, remove, current)];
  try {
    await gh(repo, args);
  } catch (error) {
    await retryWithLabel(repo, args, add, error);
  }
}

async function retryWithLabel(
  repo: Repo,
  args: string[],
  label: string,
  error: unknown,
): Promise<void> {
  KNOWN_LABELS.delete(slug(repo));
  const created = await createUnknownLabel(repo, label);
  if (created === 'known') {
    throw error;
  }
  if (created instanceof Error) {
    throw created;
  }
  await gh(repo, args);
}

async function knownLabels(repo: Repo): Promise<Set<string>> {
  const repoSlug = slug(repo);
  const cached = KNOWN_LABELS.get(repoSlug);
  if (cached !== undefined) {
    return cached;
  }
  const listed = await ghJson<Array<{ name: string }>>(repo, [
    'label',
    'list',
    '--limit',
    '1000',
    '--json',
    'name',
  ]);
  const known = new Set(names(listed));
  KNOWN_LABELS.set(repoSlug, known);
  return known;
}

async function createUnknownLabel(repo: Repo, label: string): Promise<'known' | 'created' | Error> {
  const known = await knownLabels(repo);
  if (known.has(label)) {
    return 'known';
  }
  try {
    await ghOnce(repo, ['label', 'create', label]);
  } catch (error) {
    return asError(error);
  }
  known.add(label);
  return 'created';
}

export async function findPr(repo: Repo, branch: string): Promise<number | undefined> {
  const parsed = await ghJson<Array<{ number: number }>>(repo, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  return parsed[0]?.number;
}

export async function createPr(
  repo: Repo,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<number> {
  const created = await ghOnce(repo, [
    'pr',
    'create',
    '--head',
    branch,
    '--base',
    base,
    '--title',
    title,
    '--body',
    body,
    ...(draft ? ['--draft'] : []),
  ]);
  const number = prNumber(created) ?? (await findPr(repo, branch));
  if (number === undefined) {
    throw new Error(`The pull request for ${branch} was not found after creation.`);
  }
  return number;
}

export function prNumber(output: string): number | undefined {
  const match = /\/pull\/(\d+)\b/.exec(output);
  return match === null ? undefined : Number(match[1]);
}

async function prField(repo: Repo, pr: number, field: string): Promise<string> {
  return gh(repo, ['pr', 'view', String(pr), '--json', field, '--jq', `.${field}`]);
}

async function readChecks(repo: Repo, pr: number): Promise<CheckSummary[] | 'none'> {
  const result = await ghRun(repo, [
    'pr',
    'checks',
    String(pr),
    '--json',
    'name,bucket,link,description',
  ]);
  const output = result.stdout.trim();
  if (output.length === 0) {
    if (NO_CHECKS.test(result.stderr)) {
      return 'none';
    }
    throw new Error(`gh pr checks ${pr} failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  const checks = JSON.parse(output) as CheckSummary[];
  return checks.length === 0 ? 'none' : checks;
}

async function watchOnce(
  repo: Repo,
  pr: number,
  intervalSeconds: number,
  timeoutMs: number,
  show: boolean,
): Promise<CheckState> {
  const watch = await ghRun(
    repo,
    ['pr', 'checks', String(pr), '--watch', '--fail-fast', '--interval', String(intervalSeconds)],
    { show, timeoutMs },
  );
  if (watch.timedOut) {
    return 'timeout';
  }
  if (watch.code === 0) {
    return 'pass';
  }
  if (watch.code === CHECK_PENDING_CODE) {
    return 'pending';
  }
  const checks = await readChecks(repo, pr);
  if (checks !== 'none' && checks.some((check) => check.bucket === 'fail')) {
    return 'fail';
  }
  throw new Error(
    `gh pr checks ${pr} --watch failed with code ${watch.code} and no check failed: ${watch.stderr.trim()}`,
  );
}

export type ChecksProbe = {
  head: () => Promise<string>;
  lags: (head: string) => Promise<boolean>;
  list: () => Promise<'none' | 'some'>;
  watch: (timeoutMs: number) => Promise<CheckState>;
};

export type PollOptions = Polling & {
  graceMs: number;
  head?: string;
};

export type WaitOptions = PollOptions & { show: boolean };

export async function pollChecks(
  probe: ChecksProbe,
  options: PollOptions,
  clock: Clock = REAL_CLOCK,
): Promise<CheckState> {
  const deadline = clock.now() + options.timeoutMs;
  const rest = (): number => Math.max(0, deadline - clock.now());
  let shown: number | undefined;
  let failures = 0;
  for (;;) {
    if (rest() === 0) {
      return 'timeout';
    }
    const state = await read(probe, options.head, rest(), () => (shown ??= clock.now()));
    if (state === 'behind' && shown !== undefined) {
      return 'moved';
    }
    if (state instanceof Error) {
      failures += 1;
      if (failures >= READ_TRIES) {
        throw state;
      }
    } else {
      failures = 0;
      const outcome = settled(state, clock.now() - (shown ?? 0), options.graceMs);
      if (outcome !== undefined) {
        return outcome;
      }
    }
    await pause(clock, options, rest());
  }
}

function settled(
  state: CheckState | 'behind',
  waitedMs: number,
  graceMs: number,
): CheckState | undefined {
  if (state === 'none') {
    return waitedMs >= graceMs ? 'none' : undefined;
  }
  return state === 'behind' || state === 'pending' ? undefined : state;
}

async function read(
  probe: ChecksProbe,
  head: string | undefined,
  timeoutMs: number,
  shown: () => void,
): Promise<CheckState | 'none' | 'behind' | Error> {
  try {
    if (head !== undefined) {
      const current = await probe.head();
      if (current !== head) {
        return (await probe.lags(current)) ? 'behind' : 'moved';
      }
    }
    shown();
    if ((await probe.list()) === 'none') {
      return 'none';
    }
    const state = await probe.watch(timeoutMs);
    if (head !== undefined && (await probe.head()) !== head) {
      return 'moved';
    }
    return state;
  } catch (error) {
    return asError(error);
  }
}

export function waitForChecks(repo: Repo, pr: number, options: WaitOptions): Promise<CheckState> {
  return pollChecks(
    {
      head: () => prField(repo, pr, 'headRefOid'),
      lags: (head) =>
        options.head === undefined
          ? Promise.resolve(true)
          : isAncestor(repo.root, head, options.head),
      list: async () => ((await readChecks(repo, pr)) === 'none' ? 'none' : 'some'),
      watch: (timeoutMs) => watchOnce(repo, pr, options.intervalSeconds, timeoutMs, options.show),
    },
    options,
  );
}

export async function failedCheckLogs(repo: Repo, pr: number, maxChars: number): Promise<string> {
  const checks = await readChecks(repo, pr);
  if (checks === 'none') {
    return 'The checks failed, but gh reports no check for the pull request.';
  }
  const failed = checks
    .filter((check) => check.bucket === 'fail')
    .map((check) => ({
      heading: `## ${check.name}\n${check.description}`,
      runId: /\/actions\/runs\/(\d+)/.exec(check.link)?.[1],
    }));
  return runLogs(repo, failed, maxChars);
}

async function baseRuns(repo: Repo, sha: string): Promise<BaseRun[]> {
  return ghJson<BaseRun[]>(repo, [
    'run',
    'list',
    '--commit',
    sha,
    '--json',
    'databaseId,name,status,conclusion',
  ]);
}

function failedRun(entry: BaseRun): boolean {
  return entry.status === 'completed' && FAILED_CONCLUSIONS.has(entry.conclusion);
}

function baseState(runs: BaseRun[]): CheckState {
  if (runs.some(failedRun)) {
    return 'fail';
  }
  return runs.every((entry) => entry.status === 'completed') ? 'pass' : 'pending';
}

export function waitForBaseChecks(
  repo: Repo,
  sha: string,
  options: PollOptions,
): Promise<CheckState> {
  return pollChecks(
    {
      head: async () => sha,
      lags: async () => true,
      list: async () => ((await baseRuns(repo, sha)).length === 0 ? 'none' : 'some'),
      watch: async () => baseState(await baseRuns(repo, sha)),
    },
    options,
  );
}

export async function failedBaseLogs(repo: Repo, sha: string, maxChars: number): Promise<string> {
  const failed = (await baseRuns(repo, sha))
    .filter(failedRun)
    .map((entry) => ({ heading: `## ${entry.name}`, runId: String(entry.databaseId) }));
  return runLogs(repo, failed, maxChars);
}

async function runLogs(
  repo: Repo,
  failed: Array<{ heading: string; runId: string | undefined }>,
  maxChars: number,
): Promise<string> {
  const share = Math.max(1, Math.floor(maxChars / Math.max(1, failed.length)));
  const parts: string[] = [];
  for (const { heading, runId } of failed) {
    parts.push(heading);
    if (runId === undefined) {
      continue;
    }
    parts.push(await runLog(repo, runId, share));
  }
  return parts.join('\n\n');
}

async function runLog(repo: Repo, runId: string, share: number): Promise<string> {
  const logs = await ghRun(repo, ['run', 'view', runId, '--log-failed'], { tailChars: share });
  if (logs.code === 0) {
    return logs.stdout;
  }
  const reason = joinFilled(
    [`The log read failed with code ${logs.code}.`, logs.stderr.trim()],
    ' ',
  );
  return joinFilled([logs.stdout.trim(), reason], '\n');
}

function joinFilled(parts: string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator);
}

export async function markPrReady(repo: Repo, pr: number): Promise<boolean> {
  return ghSucceeds(repo, ['pr', 'ready', String(pr)]);
}

export async function mergePr(repo: Repo, pr: number): Promise<boolean> {
  return ghSucceeds(repo, ['pr', 'merge', String(pr), '--squash', '--delete-branch']);
}

export async function prConflicts(
  repo: Repo,
  pr: number,
  options: Polling,
  clock: Clock = REAL_CLOCK,
): Promise<boolean> {
  const mergeable = await pollUntil(
    options,
    clock,
    () => prField(repo, pr, 'mergeable'),
    (value) => value !== 'UNKNOWN',
  );
  return mergeable === 'CONFLICTING';
}

export async function prMerged(repo: Repo, pr: number): Promise<boolean> {
  return (await prField(repo, pr, 'state')) === 'MERGED';
}

export async function mergeCommit(
  repo: Repo,
  pr: number,
  options: Polling,
  clock: Clock = REAL_CLOCK,
): Promise<string | undefined> {
  const view = await pollUntil(
    options,
    clock,
    () =>
      ghJson<{ state: string; mergeCommit: { oid: string } | null }>(repo, [
        'pr',
        'view',
        String(pr),
        '--json',
        'state,mergeCommit',
      ]),
    (value) => (value.state === 'MERGED' && !!value.mergeCommit?.oid) || value.state === 'CLOSED',
  );
  return (view.state === 'MERGED' && view.mergeCommit?.oid) || undefined;
}

export async function reopenIssue(repo: Repo, issue: number): Promise<void> {
  await gh(repo, ['issue', 'reopen', String(issue)]);
}

async function comment(repo: Repo, kind: Kind, number: number, body: string): Promise<void> {
  await ghOnce(repo, [kind, 'comment', String(number), '--body-file', '-'], body);
}

export async function commentOnIssue(repo: Repo, issue: number, body: string): Promise<void> {
  await comment(repo, 'issue', issue, body);
}

export async function commentOnPr(repo: Repo, pr: number, body: string): Promise<void> {
  await comment(repo, 'pr', pr, body);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
