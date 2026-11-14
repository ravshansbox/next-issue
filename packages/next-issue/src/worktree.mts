import { join } from 'node:path';
import {
  currentBranch,
  discardChanges,
  git,
  gitFetch,
  isAncestor,
  oneFetchAtATime,
  remoteRef,
  type Repo,
  succeeds,
} from './git.mts';

type Worktree = {
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
  const upstream = remoteRef(remote, branch);
  const remoteBase = remoteRef(remote, base);
  const baseUpdated = await fastForwardBase(repo, base, remote);
  await git(repo.root, ['worktree', 'prune']);
  const pushed = await hasBranch(repo, upstream, '--remotes');
  const existing = await findWorktree(repo, branch);
  const path = existing ?? worktreePath(repo, issue);
  const target = pushed ? upstream : remoteBase;
  if (existing === undefined) {
    await succeeds(repo.root, ['worktree', 'remove', '--force', path]);
    const args =
      !start && (await hasWork(repo, branch, pushed, remoteBase))
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-B', branch, path, target];
    await git(repo.root, args);
  } else if (start) {
    await discardChanges(path, target);
  }
  if (pushed) {
    await succeeds(path, ['merge', '--ff-only', upstream]);
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

export async function fastForwardBase(repo: Repo, base: string, remote: string): Promise<boolean> {
  await gitFetch(repo.root, [remote]);
  return updateBase(repo, base, remote);
}

async function updateBase(repo: Repo, base: string, remote: string): Promise<boolean> {
  const remoteBase = remoteRef(remote, base);
  const args =
    (await currentBranch(repo.root)) === base
      ? ['merge', '--ff-only', remoteBase]
      : ['fetch', '.', `${remoteBase}:${base}`];
  return oneFetchAtATime(() => succeeds(repo.root, args));
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
