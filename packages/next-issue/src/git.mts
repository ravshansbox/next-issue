import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { must, run } from './exec.mts';

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
  return must('git', ['rev-parse', '--show-toplevel'], { cwd });
}

export async function detectRepo(cwd: string, remote: string): Promise<Repo> {
  const root = await repoRoot(cwd);
  const url = await must('git', ['remote', 'get-url', remote], { cwd });
  const { owner, name } = parseRemote(url);
  return { owner, name, root };
}

export type Worktree = {
  path: string;
  baseUpdated: boolean;
};

export const WORKTREE_DIR = '.worktrees';

export function worktreePath(repo: Repo, issue: number): string {
  return join(repo.root, WORKTREE_DIR, String(issue));
}

export async function addWorktree(
  repo: Repo,
  issue: number,
  branch: string,
  base: string,
  remote: string,
): Promise<Worktree> {
  const upstream = `${remote}/${branch}`;
  await must('git', ['fetch', remote], { cwd: repo.root });
  const baseUpdated = await updateBase(repo, base, remote);
  await must('git', ['worktree', 'prune'], { cwd: repo.root });
  const pushed = await hasBranch(repo, upstream, '--remotes');
  const existing = await findWorktree(repo, branch);
  const path = existing ?? worktreePath(repo, issue);
  if (existing === undefined) {
    const args = (await hasBranch(repo, branch))
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, pushed ? upstream : `${remote}/${base}`];
    await must('git', args, { cwd: repo.root });
  }
  if (pushed) {
    await run('git', ['merge', '--ff-only', upstream], { cwd: path });
  }
  return { path, baseUpdated };
}

async function hasBranch(repo: Repo, name: string, ...flags: string[]): Promise<boolean> {
  const list = await must('git', ['branch', '--list', ...flags, name], { cwd: repo.root });
  return list.length > 0;
}

export async function updateBase(repo: Repo, base: string, remote: string): Promise<boolean> {
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root });
  const args =
    head.code === 0 && head.stdout.trim() === base
      ? ['merge', '--ff-only', `${remote}/${base}`]
      : ['fetch', '.', `${remote}/${base}:${base}`];
  const result = await run('git', args, { cwd: repo.root });
  return result.code === 0;
}

export async function findWorktree(repo: Repo, branch: string): Promise<string | undefined> {
  const list = await must('git', ['worktree', 'list', '--porcelain'], { cwd: repo.root });
  const entry = list
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`));
  return entry?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
}

export async function removeWorktree(repo: Repo, path: string): Promise<boolean> {
  const result = await run('git', ['worktree', 'remove', path], { cwd: repo.root });
  return result.code === 0;
}

export async function ensureIgnored(root: string, entry: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    current = '';
  }
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
  const status = await must('git', ['status', '--porcelain'], { cwd });
  return status.length > 0;
}

export async function diff(cwd: string, base: string, remote: string): Promise<string> {
  return must('git', ['diff', `${remote}/${base}...HEAD`], { cwd });
}

export class HookError extends Error {}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await must('git', ['add', '-A'], { cwd });
  const folder = await mkdtemp(join(tmpdir(), 'next-issue-message-'));
  const file = join(folder, 'COMMIT_EDITMSG');
  try {
    await writeFile(file, `${message}\n`);
    await runHook(cwd, 'pre-commit');
    await runHook(cwd, 'commit-msg', file);
    await must('git', ['commit', '--no-verify', '-F', file], { cwd });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return true;
}

async function runHook(cwd: string, name: string, ...args: string[]): Promise<void> {
  try {
    await must('git', ['hook', 'run', '--ignore-missing', name, '--', ...args], { cwd });
  } catch (error) {
    throw new HookError(error instanceof Error ? error.message : String(error));
  }
}

export async function discardChanges(cwd: string, target: string): Promise<boolean> {
  if (!(await isDirty(cwd)) && (await revision(cwd)) === target) {
    return false;
  }
  await must('git', ['reset', '--hard', target], { cwd });
  await must('git', ['clean', '-fd'], { cwd });
  return true;
}

export async function setAside(cwd: string, target: string, branch: string): Promise<void> {
  await must('git', ['branch', branch], { cwd });
  if (await isDirty(cwd)) {
    await must('git', ['reset', '--soft', target], { cwd });
    return;
  }
  await discardChanges(cwd, target);
}

export async function disputeBranches(repo: Repo, branch: string): Promise<string[]> {
  const list = await must(
    'git',
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}-dispute-*`],
    { cwd: repo.root },
  );
  return list.split('\n').filter((line) => line.length > 0);
}

export async function push(
  cwd: string,
  remote: string,
  branch: string,
  force = false,
): Promise<void> {
  await must('git', ['push', '-u', ...(force ? ['--force'] : []), remote, branch], { cwd });
}

export async function resetToBase(cwd: string, base: string, remote: string): Promise<void> {
  await must('git', ['fetch', remote, base], { cwd });
  await must('git', ['reset', '--hard', `${remote}/${base}`], { cwd });
}

export async function revision(cwd: string): Promise<string> {
  return must('git', ['rev-parse', 'HEAD'], { cwd });
}

export async function deleteBranch(repo: Repo, branch: string): Promise<boolean> {
  const result = await run('git', ['branch', '-D', branch], { cwd: repo.root });
  return result.code === 0;
}
