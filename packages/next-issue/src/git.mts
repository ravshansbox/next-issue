import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lines, must, run } from './exec.mts';
import { message } from './observe.mts';

export type Repo = {
  owner: string;
  name: string;
  root: string;
};

const REMOTE_PATTERNS = [
  /^git@[^:]+:(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^ssh:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^https?:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
];

export function parseRemote(url: string): { owner: string; name: string } {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (match?.groups) {
      return { owner: match.groups.owner!, name: match.groups.name! };
    }
  }
  throw new Error(`Cannot parse the git remote URL: ${url}`);
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export async function detectRepo(cwd: string, remote: string): Promise<Repo> {
  const root = await repoRoot(cwd);
  const url = await git(cwd, ['remote', 'get-url', remote]);
  const { owner, name } = parseRemote(url);
  return { owner, name, root };
}

export type Worktree = {
  path: string;
  baseUpdated: boolean;
};

export const WORKTREE_DIR = '.worktrees';

function worktreePath(repo: Repo, issue: number): string {
  return join(repo.root, WORKTREE_DIR, String(issue));
}

export async function addWorktree(
  repo: Repo,
  issue: number,
  branch: string,
  base: string,
  remote: string,
  start: boolean,
): Promise<Worktree> {
  const upstream = `${remote}/${branch}`;
  await git(repo.root, ['fetch', remote]);
  const baseUpdated = await updateBase(repo, base, remote);
  await git(repo.root, ['worktree', 'prune']);
  const pushed = await hasBranch(repo, upstream, '--remotes');
  const existing = await findWorktree(repo, branch);
  const path = existing ?? worktreePath(repo, issue);
  const target = pushed ? upstream : `${remote}/${base}`;
  if (existing === undefined) {
    const args =
      !start && (await hasWork(repo, branch, pushed, `${remote}/${base}`))
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-B', branch, path, target];
    await git(repo.root, args);
  } else if (start) {
    await discardChanges(path, target);
  }
  if (pushed) {
    await run('git', ['merge', '--ff-only', upstream], { cwd: path });
  }
  return { path, baseUpdated };
}

async function hasWork(
  repo: Repo,
  branch: string,
  pushed: boolean,
  base: string,
): Promise<boolean> {
  if (!(await hasBranch(repo, branch))) {
    return false;
  }
  return pushed || !(await isAncestor(repo.root, branch, base));
}

async function hasBranch(repo: Repo, name: string, ...flags: string[]): Promise<boolean> {
  const list = await git(repo.root, ['branch', '--list', ...flags, name]);
  return list.length > 0;
}

async function updateBase(repo: Repo, base: string, remote: string): Promise<boolean> {
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root });
  const args =
    head.code === 0 && head.stdout.trim() === base
      ? ['merge', '--ff-only', `${remote}/${base}`]
      : ['fetch', '.', `${remote}/${base}:${base}`];
  return succeeds(repo.root, args);
}

export async function findWorktree(repo: Repo, branch: string): Promise<string | undefined> {
  const list = await git(repo.root, ['worktree', 'list', '--porcelain']);
  const entry = list
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`));
  return entry?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
}

export async function removeWorktree(repo: Repo, path: string): Promise<boolean> {
  return succeeds(repo.root, ['worktree', 'remove', path]);
}

export async function ensureIgnored(root: string, entry: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === entry)) {
    return false;
  }
  const gap = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await appendFile(path, `${gap}${entry}\n`);
  return true;
}

export function branchName(issue: number): string {
  return String(issue);
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  return status.length > 0;
}

export async function diff(cwd: string, base: string, remote: string): Promise<string> {
  return git(cwd, ['diff', `${remote}/${base}...HEAD`]);
}

export class HookError extends Error {}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await commitEverything(cwd, message);
  return true;
}

async function commitEverything(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  const folder = await mkdtemp(join(tmpdir(), 'next-issue-message-'));
  const file = join(folder, 'COMMIT_EDITMSG');
  try {
    await writeFile(file, `${message}\n`);
    await runHook(cwd, 'pre-commit');
    await runHook(cwd, 'commit-msg', file);
    await git(cwd, ['commit', '--no-verify', '-F', file]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function runHook(cwd: string, name: string, ...args: string[]): Promise<void> {
  try {
    await git(cwd, ['hook', 'run', '--ignore-missing', name, '--', ...args]);
  } catch (error) {
    throw new HookError(message(error));
  }
}

export async function discardChanges(cwd: string, target: string): Promise<boolean> {
  if (!(await isDirty(cwd)) && (await revision(cwd)) === target) {
    return false;
  }
  await resetHard(cwd, target);
  return true;
}

async function resetHard(cwd: string, target: string): Promise<void> {
  await git(cwd, ['reset', '--hard', target]);
  await git(cwd, ['clean', '-fd']);
}

export async function setAside(cwd: string, target: string, branch: string): Promise<void> {
  await git(cwd, ['branch', branch]);
  if (await isDirty(cwd)) {
    await git(cwd, ['reset', '--soft', target]);
    return;
  }
  await discardChanges(cwd, target);
}

export async function disputeBranches(repo: Repo, branch: string): Promise<string[]> {
  const list = await git(repo.root, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${branch}-dispute-*`,
  ]);
  return lines(list);
}

export async function push(
  cwd: string,
  remote: string,
  branch: string,
  force = false,
): Promise<void> {
  await git(cwd, ['push', '-u', ...(force ? ['--force'] : []), remote, branch]);
}

async function fetchBase(cwd: string, base: string, remote: string): Promise<string> {
  await git(cwd, ['fetch', remote, base]);
  return `${remote}/${base}`;
}

export async function resetToBase(cwd: string, base: string, remote: string): Promise<void> {
  const target = await fetchBase(cwd, base, remote);
  await git(cwd, ['reset', '--hard', target]);
}

export async function startMerge(
  cwd: string,
  base: string,
  remote: string,
): Promise<string[] | undefined> {
  const target = await fetchBase(cwd, base, remote);
  const result = await run('git', ['merge', '--no-ff', '--no-commit', target], { cwd });
  if (result.code === 0) {
    return (await merging(cwd)) ? [] : undefined;
  }
  const listed = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  const files = lines(listed);
  if (files.length === 0) {
    throw new Error(`git merge ${target} failed: ${result.stderr.trim()}`);
  }
  return files;
}

async function merging(cwd: string): Promise<boolean> {
  return succeeds(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
}

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export async function commitMerge(cwd: string, files: string[], message: string): Promise<boolean> {
  if (!(await merging(cwd))) {
    return false;
  }
  for (const file of files) {
    const text = await readFile(join(cwd, file), 'utf8').catch(() => '');
    if (CONFLICT_MARKER.test(text)) {
      return false;
    }
  }
  await commitEverything(cwd, message);
  return true;
}

export async function abortMerge(cwd: string, target: string): Promise<void> {
  await resetHard(cwd, target);
}

export async function latestSubject(
  cwd: string,
  base: string,
  remote: string,
): Promise<string | undefined> {
  const subject = await git(cwd, ['log', '-1', '--format=%s', `${remote}/${base}..HEAD`]);
  return subject === '' ? undefined : subject;
}

export async function revision(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return succeeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

export async function deleteBranch(repo: Repo, branch: string): Promise<boolean> {
  return succeeds(repo.root, ['branch', '-D', branch]);
}

async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await run('git', args, { cwd });
  return result.code === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return must('git', args, { cwd });
}
