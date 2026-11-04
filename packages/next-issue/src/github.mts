import { errorMatches } from './errors.mts';
import { lines } from './exec.mts';
import { gh, ghApi, ghJson, ghOnce, type Named, names, repeatable, slug } from './gh.mts';
import type { Repo } from './git.mts';

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
  labels: Named[];
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
    parsed = JSON.parse(line);
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
    if (errorMatches(error, /HTTP 404/)) {
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
