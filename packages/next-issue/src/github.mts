import { must, run, type RunOptions } from './exec.mts';
import { isAncestor, type Repo } from './git.mts';

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

async function repeatable(args: string[], options: RunOptions): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await must('gh', args, options);
    } catch (error) {
      if (
        attempt >= NETWORK_TRIES ||
        !(error instanceof Error) ||
        !NETWORK_FAULT.test(error.message)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

async function gh(repo: Repo, args: string[]): Promise<string> {
  return repeatable([...args, '--repo', slug(repo)], { cwd: repo.root });
}

async function ghOnce(repo: Repo, args: string[], input?: string): Promise<string> {
  return must('gh', [...args, '--repo', slug(repo)], { cwd: repo.root, input });
}

export async function defaultBranch(repo: Repo): Promise<string> {
  const raw = await repeatable(['repo', 'view', slug(repo), '--json', 'defaultBranchRef'], {
    cwd: repo.root,
  });
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

function toIssue(item: RawIssue): Issue {
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    createdAt: item.createdAt,
    labels: item.labels.map((label) => label.name),
  };
}

export async function openIssues(repo: Repo, limit: number, labels: string[]): Promise<Issue[]> {
  const filter =
    labels.length === 0 ? '' : ` label:${labels.map((label) => `"${label}"`).join(',')}`;
  const raw = await gh(repo, [
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `sort:created-asc${filter}`,
    '--limit',
    String(limit),
    '--json',
    ISSUE_FIELDS,
  ]);
  const parsed = JSON.parse(raw) as RawIssue[];
  return parsed.map(toIssue);
}

export async function viewIssue(repo: Repo, issue: number): Promise<Issue & { open: boolean }> {
  const raw = await gh(repo, ['issue', 'view', String(issue), '--json', `${ISSUE_FIELDS},state`]);
  const parsed = JSON.parse(raw) as RawIssue & { state: string };
  return { ...toIssue(parsed), open: parsed.state === 'OPEN' };
}

export type Comment = { author: string; body: string; url?: string };

export async function issueComments(repo: Repo, issue: number): Promise<Comment[]> {
  const raw = await gh(repo, ['issue', 'view', String(issue), '--json', 'comments']);
  const parsed = JSON.parse(raw) as {
    comments: Array<{ author: { login: string }; body: string }>;
  };
  return parsed.comments.map((comment) => ({ author: comment.author.login, body: comment.body }));
}

export async function threadComments(repo: Repo, number: number): Promise<Comment[]> {
  const raw = await repeatable(
    [
      'api',
      '--paginate',
      `repos/${slug(repo)}/issues/${number}/comments`,
      '--jq',
      '.[] | [.user.login, .body, .html_url] | @json',
    ],
    { cwd: repo.root },
  );
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      let parsed: [string, string | null, string?];
      try {
        parsed = JSON.parse(line) as [string, string | null, string?];
      } catch {
        throw new Error(`gh gave a comment of #${number} that is not valid JSON: ${line}`);
      }
      const [author, body, url] = parsed;
      return url === undefined ? { author, body: body ?? '' } : { author, body: body ?? '', url };
    });
}

export async function canWrite(repo: Repo, login: string): Promise<boolean> {
  try {
    const permission = await repeatable(
      ['api', `repos/${slug(repo)}/collaborators/${login}/permission`, '--jq', '.permission'],
      { cwd: repo.root },
    );
    return ['admin', 'write'].includes(permission.trim());
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

export async function openBlockers(repo: Repo, issue: number): Promise<string[]> {
  const raw = await repeatable(
    [
      'api',
      '--paginate',
      `repos/${slug(repo)}/issues/${issue}/dependencies/blocked_by`,
      '--jq',
      '.[] | select(.state == "open") | (.repository_url | split("/") | .[-2:] | join("/")) + "#" + (.number | tostring)',
    ],
    { cwd: repo.root },
  );
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((ref) => (ref.startsWith(`${slug(repo)}#`) ? ref.slice(slug(repo).length) : ref));
}

async function labelsOf(repo: Repo, kind: Kind, number: number): Promise<string[]> {
  const raw = await gh(repo, [kind, 'view', String(number), '--json', 'labels']);
  const parsed = JSON.parse(raw) as { labels: Array<{ name: string }> };
  return parsed.labels.map((label) => label.name);
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
    KNOWN_LABELS.delete(slug(repo));
    const created = await createUnknownLabel(repo, add);
    if (created === 'known') {
      throw error;
    }
    if (created instanceof Error) {
      throw created;
    }
    await gh(repo, args);
  }
}

async function createUnknownLabel(repo: Repo, label: string): Promise<'known' | 'created' | Error> {
  let known = KNOWN_LABELS.get(slug(repo));
  if (known === undefined) {
    const raw = await gh(repo, ['label', 'list', '--limit', '1000', '--json', 'name']);
    known = new Set((JSON.parse(raw) as Array<{ name: string }>).map((item) => item.name));
    KNOWN_LABELS.set(slug(repo), known);
  }
  if (known.has(label)) {
    return 'known';
  }
  try {
    await ghOnce(repo, ['label', 'create', label]);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  known.add(label);
  return 'created';
}

export async function findPr(repo: Repo, branch: string): Promise<number | undefined> {
  const raw = await gh(repo, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  const parsed = JSON.parse(raw) as Array<{ number: number }>;
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

async function prHead(repo: Repo, pr: number): Promise<string> {
  return gh(repo, ['pr', 'view', String(pr), '--json', 'headRefOid', '--jq', '.headRefOid']);
}

async function readChecks(repo: Repo, pr: number): Promise<CheckSummary[] | 'none'> {
  const result = await run(
    'gh',
    ['pr', 'checks', String(pr), '--json', 'name,bucket,link,description', '--repo', slug(repo)],
    { cwd: repo.root },
  );
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
  const watch = await run(
    'gh',
    [
      'pr',
      'checks',
      String(pr),
      '--watch',
      '--fail-fast',
      '--interval',
      String(intervalSeconds),
      '--repo',
      slug(repo),
    ],
    { cwd: repo.root, show, timeoutMs },
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

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type PollOptions = {
  intervalSeconds: number;
  graceMs: number;
  timeoutMs: number;
  head?: string;
};

export type WaitOptions = PollOptions & { show: boolean };

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
      if (state === 'none' && clock.now() - (shown ?? 0) >= options.graceMs) {
        return 'none';
      }
      if (state !== 'none' && state !== 'behind' && state !== 'pending') {
        return state;
      }
    }
    await clock.sleep(Math.min(options.intervalSeconds * 1000, rest()));
  }
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
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function waitForChecks(repo: Repo, pr: number, options: WaitOptions): Promise<CheckState> {
  return pollChecks(
    {
      head: () => prHead(repo, pr),
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
  const raw = await gh(repo, [
    'run',
    'list',
    '--commit',
    sha,
    '--json',
    'databaseId,name,status,conclusion',
  ]);
  return JSON.parse(raw) as BaseRun[];
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
    const logs = await run('gh', ['run', 'view', runId, '--log-failed', '--repo', slug(repo)], {
      cwd: repo.root,
      tailChars: share,
    });
    if (logs.code === 0) {
      parts.push(logs.stdout);
      continue;
    }
    const reason = [`The log read failed with code ${logs.code}.`, logs.stderr.trim()]
      .filter((line) => line !== '')
      .join(' ');
    parts.push([logs.stdout.trim(), reason].filter((line) => line !== '').join('\n'));
  }
  return parts.join('\n\n');
}

export async function markPrReady(repo: Repo, pr: number): Promise<boolean> {
  const result = await run('gh', ['pr', 'ready', String(pr), '--repo', slug(repo)], {
    cwd: repo.root,
  });
  return result.code === 0;
}

export async function mergePr(repo: Repo, pr: number): Promise<boolean> {
  const result = await run(
    'gh',
    ['pr', 'merge', String(pr), '--squash', '--delete-branch', '--repo', slug(repo)],
    { cwd: repo.root },
  );
  return result.code === 0;
}

export async function prConflicts(
  repo: Repo,
  pr: number,
  options: { intervalSeconds: number; timeoutMs: number },
  clock: Clock = REAL_CLOCK,
): Promise<boolean> {
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const mergeable = (
      await gh(repo, ['pr', 'view', String(pr), '--json', 'mergeable', '--jq', '.mergeable'])
    ).trim();
    const rest = deadline - clock.now();
    if (mergeable !== 'UNKNOWN' || rest <= 0) {
      return mergeable === 'CONFLICTING';
    }
    await clock.sleep(Math.min(options.intervalSeconds * 1000, rest));
  }
}

export async function prMerged(repo: Repo, pr: number): Promise<boolean> {
  return (
    (await gh(repo, ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state'])).trim() ===
    'MERGED'
  );
}

export async function mergeCommit(
  repo: Repo,
  pr: number,
  options: { intervalSeconds: number; timeoutMs: number },
  clock: Clock = REAL_CLOCK,
): Promise<string | undefined> {
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const raw = await gh(repo, ['pr', 'view', String(pr), '--json', 'state,mergeCommit']);
    const view = JSON.parse(raw) as { state: string; mergeCommit: { oid: string } | null };
    if (view.state === 'MERGED' && view.mergeCommit?.oid) {
      return view.mergeCommit.oid;
    }
    const rest = deadline - clock.now();
    if (view.state === 'CLOSED' || rest <= 0) {
      return undefined;
    }
    await clock.sleep(Math.min(options.intervalSeconds * 1000, rest));
  }
}

export async function reopenIssue(repo: Repo, issue: number): Promise<void> {
  await gh(repo, ['issue', 'reopen', String(issue)]);
}

export async function commentOnIssue(repo: Repo, issue: number, body: string): Promise<void> {
  await ghOnce(repo, ['issue', 'comment', String(issue), '--body-file', '-'], body);
}

export async function commentOnPr(repo: Repo, pr: number, body: string): Promise<void> {
  await ghOnce(repo, ['pr', 'comment', String(pr), '--body-file', '-'], body);
}
