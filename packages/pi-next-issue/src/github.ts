import { setTimeout as sleep } from 'node:timers/promises';
import { must, run } from './exec.ts';
import { LABELS, STOP_LABELS, type ChecksResult, type Issue, type MergeResult } from './runner.ts';

export type Repo = { root: string; slug: string };

type Check = { name: string; bucket: string; link: string };

const POLL_MS = 15_000;
const GRACE_MS = 60_000;
const READ_TRIES = 3;
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function gh(repo: Repo, args: string[], input?: string): Promise<string> {
  return must('gh', [...args, '--repo', repo.slug], {
    cwd: repo.root,
    ...(input === undefined ? {} : { input }),
  });
}

export async function defaultBranch(repo: Repo): Promise<string> {
  return must(
    'gh',
    ['repo', 'view', repo.slug, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    {
      cwd: repo.root,
    },
  );
}

type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  labels: Array<{ name: string }>;
};

const ISSUE_FIELDS = 'number,title,body,labels,createdAt';

export async function openIssues(
  repo: Repo,
  saved: number[],
): Promise<{ open: Issue[]; closed: number[] }> {
  const raw = await gh(repo, [
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    LABELS.ready,
    '--search',
    ['sort:created-asc', ...STOP_LABELS.map((label) => `-label:${label}`)].join(' '),
    '--limit',
    '200',
    '--json',
    ISSUE_FIELDS,
  ]);
  const listed = JSON.parse(raw) as RawIssue[];
  const known = new Set(listed.map((item) => item.number));
  const closed: number[] = [];
  for (const number of saved.filter((item) => !known.has(item))) {
    const view = await run(
      'gh',
      ['issue', 'view', String(number), '--json', `${ISSUE_FIELDS},state`, '--repo', repo.slug],
      { cwd: repo.root },
    );
    if (view.code !== 0) {
      continue;
    }
    const item = JSON.parse(view.stdout) as RawIssue & { state: string };
    if (item.state === 'OPEN') {
      listed.push(item);
    } else {
      closed.push(number);
    }
  }
  const open = listed
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body ?? '',
      labels: item.labels.map((label) => label.name),
    }));
  return { open, closed };
}

export async function comments(repo: Repo, issue: number): Promise<string[]> {
  const raw = await gh(repo, ['issue', 'view', String(issue), '--json', 'comments']);
  const parsed = JSON.parse(raw) as {
    comments: Array<{ author: { login: string }; authorAssociation: string; body: string }>;
  };
  return parsed.comments
    .filter((comment) => TRUSTED.includes(comment.authorAssociation))
    .map((comment) => `@${comment.author.login}: ${comment.body}`);
}

export async function setLabel(
  repo: Repo,
  issue: number,
  add: string,
  remove: string[],
): Promise<void> {
  await run('gh', ['label', 'create', add, '--repo', repo.slug], { cwd: repo.root });
  const raw = await gh(repo, [
    'issue',
    'view',
    String(issue),
    '--json',
    'labels',
    '--jq',
    '.labels[].name',
  ]);
  const current = raw.split('\n');
  const args = ['issue', 'edit', String(issue), '--add-label', add];
  for (const name of remove.filter((item) => current.includes(item))) {
    args.push('--remove-label', name);
  }
  await gh(repo, args);
}

export async function commentOnIssue(repo: Repo, issue: number, body: string): Promise<void> {
  await gh(repo, ['issue', 'comment', String(issue), '--body-file', '-'], body);
}

export async function commentOnPr(repo: Repo, pr: number, body: string): Promise<void> {
  await gh(repo, ['pr', 'comment', String(pr), '--body-file', '-'], body);
}

export async function openPr(
  repo: Repo,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<number> {
  const found = await gh(repo, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number',
  ]);
  if (found.length > 0) {
    return Number(found);
  }
  const created = await gh(repo, [
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
  ]);
  const match = /\/pull\/(\d+)/.exec(created);
  if (match === null) {
    throw new Error(`cannot read the pull request number from: ${created}`);
  }
  return Number(match[1]);
}

async function readChecks(repo: Repo, pr: number): Promise<Check[]> {
  const result = await run(
    'gh',
    ['pr', 'checks', String(pr), '--json', 'name,bucket,link', '--repo', repo.slug],
    { cwd: repo.root },
  );
  if (result.stdout.trim().length === 0) {
    if (/no checks reported/i.test(result.stderr)) {
      return [];
    }
    throw new Error(`gh pr checks ${pr} failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as Check[];
}

export async function checks(
  repo: Repo,
  pr: number,
  headSha: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ChecksResult> {
  const deadline = Date.now() + timeoutMs;
  let shownAt: number | undefined;
  let failures = 0;
  while (Date.now() < deadline) {
    try {
      const prHead = await gh(repo, [
        'pr',
        'view',
        String(pr),
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]);
      if (prHead === headSha) {
        shownAt ??= Date.now();
        const list = await readChecks(repo, pr);
        if (list.some((check) => check.bucket === 'fail' || check.bucket === 'cancel')) {
          return 'fail';
        }
        if (list.length > 0 && list.every((check) => check.bucket !== 'pending')) {
          return 'pass';
        }
        if (list.length === 0 && Date.now() - shownAt >= GRACE_MS) {
          return 'pass';
        }
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= READ_TRIES) {
        throw error;
      }
    }
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - Date.now())), undefined, { signal });
  }
  return 'timeout';
}

export async function failedLogs(repo: Repo, pr: number, maxChars: number): Promise<string> {
  const failed = (await readChecks(repo, pr)).filter(
    (check) => check.bucket === 'fail' || check.bucket === 'cancel',
  );
  const groups = new Map<string, { names: string[]; runId: string | undefined }>();
  for (const check of failed) {
    const runId = /\/actions\/runs\/(\d+)/.exec(check.link)?.[1];
    const key = runId ?? `check:${check.name}`;
    const group = groups.get(key) ?? { names: [], runId };
    group.names.push(check.name);
    groups.set(key, group);
  }
  const share = Math.max(1, Math.floor(maxChars / Math.max(1, groups.size)));
  const parts: string[] = [];
  for (const group of groups.values()) {
    parts.push(`## ${group.names.join(', ')}`);
    if (group.runId !== undefined) {
      const logs = await run(
        'gh',
        ['run', 'view', group.runId, '--log-failed', '--repo', repo.slug],
        { cwd: repo.root },
      );
      parts.push((logs.stdout || logs.stderr).slice(-share));
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : 'The checks failed, but gh lists no failed check.';
}

export async function merge(
  repo: Repo,
  pr: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<MergeResult> {
  const before = await gh(repo, ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state']);
  if (before === 'MERGED') {
    return { merged: true };
  }
  const result = await run('gh', ['pr', 'merge', String(pr), '--squash', '--repo', repo.slug], {
    cwd: repo.root,
  });
  if (result.code !== 0) {
    return {
      merged: false,
      reason: result.stderr.trim().slice(-2000) || `gh pr merge failed with code ${result.code}`,
    };
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await gh(repo, ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state']);
    if (state === 'MERGED') {
      return { merged: true };
    }
    if (state === 'CLOSED') {
      return { merged: false, reason: 'the pull request was closed' };
    }
    if (Date.now() >= deadline) {
      return { merged: false, reason: 'the merge did not finish in time' };
    }
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - Date.now())), undefined, { signal });
  }
}
