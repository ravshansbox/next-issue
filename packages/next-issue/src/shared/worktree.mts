import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll } from './git-commit.mts';
import {
  currentBranch,
  discardChanges,
  git,
  gitFetch,
  isAncestor,
  oneFetchAtATime,
  remoteRef,
  type Repo,
  revision,
  succeeds,
} from './git.mts';

type Worktree = {
  path: string;
  baseUpdated: boolean;
  branchUpdated: boolean;
  /** The commit of the remote branch after the fetch, or `''` when there is none. */
  remoteHead: string;
};

export const WORKTREE_DIR = '.claude/worktrees';

export function huntPath(repo: Repo): string {
  return join(repo.root, WORKTREE_DIR, 'next-issue-hunt');
}

function worktreePath(repo: Repo, issue: number): string {
  return join(repo.root, WORKTREE_DIR, `next-issue-${issue}`);
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
  await refuseOwnWorktree(repo, issue, branch);
  const pushed = await hasBranch(repo, upstream, '--remotes');
  const existing = await findWorktree(repo, issue, branch);
  const path = existing ?? worktreePath(repo, issue);
  const target = pushed ? upstream : remoteBase;
  if (start) {
    await keepUnmergedCommits(repo, branch, target);
  }
  if (existing === undefined) {
    await keepDetachedEdits(path, branch);
    await succeeds(repo.root, ['worktree', 'remove', '--force', path]);
    const args =
      !start && (await hasWork(repo, branch, pushed, remoteBase))
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-B', branch, path, target];
    await git(repo.root, args);
  } else if (start) {
    await discardChanges(path, target);
  }
  const branchUpdated = !pushed || (await succeeds(path, ['merge', '--ff-only', upstream]));
  const remoteHead = pushed ? await git(repo.root, ['rev-parse', upstream]) : '';
  return { path, baseUpdated, branchUpdated, remoteHead };
}

async function keepDetachedEdits(path: string, branch: string): Promise<void> {
  if (!existsSync(join(path, '.git'))) {
    return;
  }
  if ((await currentBranch(path)) !== undefined) {
    await git(path, ['update-ref', '--no-deref', 'HEAD', 'HEAD']);
  }
  await commitAll(path, 'chore: edits left on a detached HEAD', { hooks: false });
  if ((await git(path, ['for-each-ref', '--count=1', '--contains', 'HEAD'])) !== '') {
    return;
  }
  await git(path, ['branch', `${branch}-detached-${(await revision(path)).slice(0, 7)}`]);
}

async function keepUnmergedCommits(repo: Repo, branch: string, target: string): Promise<void> {
  const local = `refs/heads/${branch}`;
  if (!(await hasBranch(repo, branch)) || (await isAncestor(repo.root, local, target))) {
    return;
  }
  const head = await git(repo.root, ['rev-parse', local]);
  await git(repo.root, ['branch', '--force', `${branch}-kept-${head.slice(0, 7)}`, local]);
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
  return pushed || !(await isAncestor(repo.root, `refs/heads/${branch}`, base));
}

async function hasBranch(repo: Repo, name: string, ...flags: string[]): Promise<boolean> {
  const list = await git(repo.root, ['branch', '--list', ...flags, name]);
  return list.length > 0;
}

export async function fastForwardBase(repo: Repo, base: string, remote: string): Promise<boolean> {
  await gitFetch(repo.root, ['--prune', remote]);
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

export async function findWorktree(
  repo: Repo,
  issue: number,
  branch: string,
): Promise<string | undefined> {
  const found = await holder(repo, branch);
  if (
    found === undefined ||
    found.main ||
    !(await samePath(found.path, worktreePath(repo, issue)))
  ) {
    return undefined;
  }
  return found.path;
}

async function refuseOwnWorktree(repo: Repo, issue: number, branch: string): Promise<void> {
  const found = await holder(repo, branch);
  if (found?.main) {
    throw new Error(
      `the main worktree at ${found.path} has branch ${branch} checked out, so the issue cannot have its own worktree; check out another branch there and try again`,
    );
  }
  if (found !== undefined && !(await samePath(found.path, worktreePath(repo, issue)))) {
    throw new Error(
      `the worktree at ${found.path} has branch ${branch} checked out, so the issue cannot have its own worktree; check out another branch there and try again`,
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
  return samePath(path, huntPath(repo));
}

async function samePath(first: string, second: string): Promise<boolean> {
  const real = (target: string) => realpath(target).catch(() => target);
  return (await real(first)) === (await real(second));
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
