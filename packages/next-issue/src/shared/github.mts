import { errorMatches, parseJson } from './errors.mts';
import {
  gh,
  ghApi,
  ghJson,
  ghOnce,
  hostname,
  type Kind,
  type Named,
  names,
  repeatable,
  repoArg,
  slug,
  viewJson,
} from './gh.mts';
import type { Repo } from './git.mts';
import { hasLabel } from './labels.mts';
import { lines } from './text.mts';

export type Issue = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: string[];
  closed?: boolean;
};

export async function defaultBranch(repo: Repo): Promise<string> {
  const raw = await repeatable(repo, ['repo', 'view', repoArg(repo), '--json', 'defaultBranchRef']);
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

function quoted(label: string): string {
  return `"${label.replace(/[\\"]/g, '\\$&')}"`;
}

function labelFilter(labels: string[], without: string[], every: string[]): string {
  const any = labels.length === 0 ? '' : ` label:${labels.map(quoted).join(',')}`;
  const all = every.map((label) => ` label:${quoted(label)}`).join('');
  return any + all + without.map((label) => ` -label:${quoted(label)}`).join('');
}

function blockedFilter(blocked: boolean | undefined): string {
  if (blocked === undefined) {
    return '';
  }
  return blocked ? ' is:blocked' : ' -is:blocked';
}

export async function openIssues(
  repo: Repo,
  limit: number,
  labels: string[],
  without: string[] = [],
  every: string[] = [],
  blocked?: boolean,
): Promise<Issue[]> {
  const parsed = await ghJson<RawIssue[]>(repo, [
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `sort:created-asc${labelFilter(labels, without, every)}${blockedFilter(blocked)}`,
    '--limit',
    String(limit),
    '--json',
    ISSUE_FIELDS,
  ]);
  return parsed.map(toIssue);
}

export async function viewIssue(repo: Repo, issue: number): Promise<Issue & { open: boolean }> {
  const parsed = await viewJson<RawIssue & { state: string }>(
    repo,
    'issue',
    issue,
    `${ISSUE_FIELDS},state`,
  );
  return { ...toIssue(parsed), open: parsed.state === 'OPEN' };
}

export type Comment = { author: string; body: string; url?: string; createdAt?: string };

export async function threadComments(repo: Repo, number: number): Promise<Comment[]> {
  const raw = await ghApi(
    repo,
    `issues/${number}/comments`,
    '.[] | [.user.login, .body, .html_url, .created_at] | @json',
    { paginate: true },
  );
  return lines(raw).map((line) => parseComment(line, number));
}

function parseComment(line: string, number: number): Comment {
  const [author, body, url, createdAt] = parseJson(
    line,
    () => `gh gave a comment of #${number} that is not valid JSON: ${line}`,
  ) as [string, string | null, string?, string?];
  return {
    author,
    body: body ?? '',
    ...(url === undefined ? {} : { url }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
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

export type Editors = { body: string; title: string };

export type IssueText = { title: string; body: string; editors: Editors };

const EDITORS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      title
      body
      author { login }
      editor { login }
      lastEditedAt
      timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 1) {
        nodes { ... on RenamedTitleEvent { actor { login } } }
      }
    }
  }
}`;

const GHOST = 'ghost';

const ISSUE_GONE = /Could not resolve to an Issue/;

type Login = { login: string } | null;

async function editorsJson(repo: Repo, issue: number): Promise<string> {
  try {
    return await repeatable(repo, [
      'api',
      'graphql',
      ...hostname(repo),
      '-f',
      `query=${EDITORS_QUERY}`,
      '-f',
      `owner=${repo.owner}`,
      '-f',
      `name=${repo.name}`,
      '-F',
      `number=${issue}`,
      '--jq',
      '.data.repository.issue',
    ]);
  } catch (error) {
    if (errorMatches(error, ISSUE_GONE)) {
      throw new Error(
        `Issue #${issue} was not found: it was deleted or moved to another repository.`,
      );
    }
    throw error;
  }
}

export async function issueEditors(repo: Repo, issue: number): Promise<IssueText> {
  const raw = await editorsJson(repo, issue);
  const parsed = parseJson(
    raw,
    () => `gh gave editors of #${issue} that are not valid JSON: ${raw}`,
  ) as {
    title: string;
    body: string;
    author: Login;
    editor: Login;
    lastEditedAt: string | null;
    timelineItems: { nodes: Array<{ actor: Login }> };
  };
  const author = parsed.author?.login ?? GHOST;
  const renamed = parsed.timelineItems.nodes[0];
  return {
    title: parsed.title,
    body: parsed.body,
    editors: {
      body: parsed.lastEditedAt === null ? author : (parsed.editor?.login ?? GHOST),
      title: renamed === undefined ? author : (renamed.actor?.login ?? GHOST),
    },
  };
}

export async function labeler(
  repo: Repo,
  issue: number,
  label: string,
): Promise<string | undefined> {
  const raw = await ghApi(
    repo,
    `issues/${issue}/events`,
    '.[] | select(.event == "labeled") | [.label.name, .actor.login] | @json',
    { paginate: true },
  );
  const added = lines(raw)
    .map(
      (line) =>
        parseJson(
          line,
          () => `gh gave a label event of #${issue} that is not valid JSON: ${line}`,
        ) as [string, string | null],
    )
    .filter(([name]) => hasLabel([name], label));
  const last = added.at(-1);
  return last === undefined ? undefined : (last[1] ?? GHOST);
}

const REPOSITORY_SLUG = '(.repository_url | split("/") | .[-2:] | join("/"))';

export async function openBlockers(repo: Repo, issue: number): Promise<string[]> {
  const raw = await ghApi(
    repo,
    `issues/${issue}/dependencies/blocked_by`,
    `.[] | select(.state == "open") | ${REPOSITORY_SLUG} + "#" + (.number | tostring)`,
    { paginate: true },
  );
  const refs = lines(raw);
  const prefixes = [`${slug(repo)}#`.toLowerCase()];
  if (refs.some((ref) => !ref.toLowerCase().startsWith(prefixes[0]))) {
    prefixes.push(`${await ghApi(repo, `issues/${issue}`, REPOSITORY_SLUG)}#`.toLowerCase());
  }
  return refs.map((ref) => {
    const prefix = prefixes.find((candidate) => ref.toLowerCase().startsWith(candidate));
    return prefix === undefined ? ref : ref.slice(prefix.length - 1);
  });
}

export async function repositorySlug(repo: Repo): Promise<string> {
  return repeatable(repo, ['api', ...hostname(repo), `repos/${slug(repo)}`, '--jq', '.full_name']);
}

export async function reopenIssue(repo: Repo, issue: number): Promise<void> {
  await gh(repo, ['issue', 'reopen', String(issue)]);
}

export async function closeIssue(repo: Repo, issue: number): Promise<void> {
  await gh(repo, ['issue', 'close', String(issue), '--reason', 'completed']);
}

async function comment(repo: Repo, kind: Kind, number: number, body: string): Promise<void> {
  await ghOnce(repo, [kind, 'comment', String(number), '--body-file', '-'], body);
}

export async function commentOnIssue(repo: Repo, issue: number, body: string): Promise<void> {
  await comment(repo, 'issue', issue, body);
}

export async function editIssueBody(repo: Repo, issue: number, body: string): Promise<void> {
  await ghOnce(repo, ['issue', 'edit', String(issue), '--body-file', '-'], body);
}
