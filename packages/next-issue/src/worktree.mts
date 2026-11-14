import { realpath } from 'node:fs/promises';
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

export function huntPath(repo: Repo): string {
  return join(repo.root, WORKTREE_DIR, 'hunt');
}

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
  await releaseFromHunt(repo, branch);
  await refuseMainWorktree(repo, branch);
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
  const found = await holder(repo, branch);
  if (found === undefined || found.main || (await isHunt(repo, found.path))) {
    return undefined;
  }
  return found.path;
}

async function refuseMainWorktree(repo: Repo, branch: string): Promise<void> {
  const found = await holder(repo, branch);
  if (found?.main) {
    throw new Error(
      `the main worktree at ${found.path} has branch ${branch} checked out, so the issue cannot have its own worktree; check out another branch there and try again`,
    );
  }
}

async function releaseFromHunt(repo: Repo, branch: string): Promise<void> {
  const found = await holder(repo, branch);
  if (found !== undefined && !found.main && (await isHunt(repo, found.path))) {
    await git(found.path, ['checkout', '--detach']);
  }
}

async function isHunt(repo: Repo, path: string): Promise<boolean> {
  const real = (target: string) => realpath(target).catch(() => target);
  return (await real(path)) === (await real(huntPath(repo)));
}

async function holder(
  repo: Repo,
  branch: string,
): Promise<{ path: string; main: boolean } | undefined> {
  const list = await git(repo.root, ['worktree', 'list', '--porcelain']);
  const blocks = list.split('\n\n').map((block) => block.split('\n'));
  const index = blocks.findIndex((lines) => lines.includes(`branch refs/heads/${branch}`));
  const path = blocks[index]
    ?.find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length);
  return path === undefined ? undefined : { path, main: index === 0 };
}

export async function removeWorktree(repo: Repo, path: string): Promise<boolean> {
  return succeeds(repo.root, ['worktree', 'remove', path]);
}
