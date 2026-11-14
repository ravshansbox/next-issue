import { evenWhenStopped } from './children.mts';
import {
  fetchBase,
  git,
  isAncestor,
  isLanded,
  isOnBase,
  oneFetchAtATime,
  revision,
  succeeds,
} from './git.mts';
import { commitEverything } from './git-commit.mts';

export const PUSH_TRIES = 3;

export async function squashOnto(cwd: string, target: string, message: string): Promise<boolean> {
  if (await succeeds(cwd, ['diff', '--quiet', target])) {
    return false;
  }
  const head = await revision(cwd);
  await git(cwd, ['reset', '--soft', target]);
  try {
    await commitEverything(cwd, message);
  } catch (error) {
    await evenWhenStopped(() => git(cwd, ['reset', '--soft', head]));
    throw error;
  }
  return true;
}

export async function pushToBase(cwd: string, remote: string, base: string): Promise<boolean> {
  return oneFetchAtATime(() => succeeds(cwd, ['push', remote, `HEAD:refs/heads/${base}`]));
}

export type Revert = {
  base: string;
  remote: string;
  branch: string;
  shas: string[];
  message: string;
  reapply: string;
  pushing: (sha: string) => Promise<void>;
};

export async function revertOnBase(cwd: string, revert: Revert): Promise<boolean> {
  const { branch } = revert;
  let moved = false;
  try {
    moved = await pushRevert(cwd, revert);
    return moved;
  } finally {
    if (!moved) {
      await succeeds(cwd, ['revert', '--abort']);
      await git(cwd, ['checkout', '--force', branch]);
    }
  }
}

export type Reapply = Pick<Revert, 'base' | 'remote' | 'branch' | 'reapply'> & {
  reverted: string;
};

export async function reapplyRevert(cwd: string, reapply: Reapply): Promise<boolean> {
  const { base, remote, branch, reverted } = reapply;
  if ((await isAncestor(cwd, reverted, 'HEAD')) && !(await isLanded(cwd, base, remote))) {
    return false;
  }
  await git(cwd, ['checkout', '--force', '--detach', reverted]);
  await git(cwd, ['clean', '-fd']);
  await commitReapply(cwd, reverted, reapply.reapply, branch);
  return true;
}

async function commitReapply(
  cwd: string,
  reverted: string,
  message: string,
  branch: string,
): Promise<void> {
  await git(cwd, ['revert', '--no-commit', reverted]);
  await git(cwd, ['commit', '--no-verify', '-m', message]);
  await git(cwd, ['checkout', '-B', branch]);
}

async function pushRevert(cwd: string, revert: Revert): Promise<boolean> {
  const { base, remote, branch, shas, message, reapply, pushing } = revert;
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
    const target = await fetchBase(cwd, base, remote);
    await git(cwd, ['checkout', '--force', '--detach', target]);
    await git(cwd, ['clean', '-fd']);
    if (!(await succeeds(cwd, ['revert', '--no-commit', ...shas.toReversed()]))) {
      return false;
    }
    await git(cwd, ['commit', '--no-verify', '-m', message]);
    const reverted = await revision(cwd);
    await pushing(reverted);
    if ((await pushToBase(cwd, remote, base)) || (await isOnBase(cwd, base, remote, reverted))) {
      await commitReapply(cwd, reverted, reapply, branch);
      return true;
    }
  }
  return false;
}
