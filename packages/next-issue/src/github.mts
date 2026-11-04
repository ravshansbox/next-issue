import { lines } from './exec.mts';
import { gh, ghApi, ghJson, ghOnce, ghSucceeds, names, repeatable, slug } from './gh.mts';
import type { Repo } from './git.mts';
import { type Clock, type Polling, pollUntil, REAL_CLOCK } from './poll.mts';

export type Issue = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: string[];
};

export type Kind = 'issue' | 'pr';

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

export async function prField(repo: Repo, pr: number, field: string): Promise<string> {
  return gh(repo, ['pr', 'view', String(pr), '--json', field, '--jq', `.${field}`]);
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
