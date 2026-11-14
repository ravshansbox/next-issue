import { fetchBase, git, oneFetchAtATime, remoteRef, revision, succeeds } from './git.mts';
import { commitEverything } from './git-commit.mts';

export const PUSH_TRIES = 3;

export async function squashOnto(
  cwd: string,
  base: string,
  remote: string,
  message: string,
): Promise<boolean> {
  const target = remoteRef(remote, base);
  if (await succeeds(cwd, ['diff', '--quiet', target])) {
    return false;
  }
  const head = await revision(cwd);
  await git(cwd, ['reset', '--soft', target]);
  try {
    await commitEverything(cwd, message);
  } catch (error) {
    await git(cwd, ['reset', '--soft', head]);
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

async function pushRevert(cwd: string, revert: Revert): Promise<boolean> {
  const { base, remote, branch, shas, message, reapply } = revert;
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
    const target = await fetchBase(cwd, base, remote);
    await git(cwd, ['checkout', '--force', '--detach', target]);
    await git(cwd, ['clean', '-fd']);
    if (!(await succeeds(cwd, ['revert', '--no-commit', ...shas.toReversed()]))) {
      return false;
    }
    await git(cwd, ['commit', '--no-verify', '-m', message]);
    if (await pushToBase(cwd, remote, base)) {
      await git(cwd, ['revert', '--no-commit', await revision(cwd)]);
      await git(cwd, ['commit', '--no-verify', '-m', reapply]);
      await git(cwd, ['checkout', '-B', branch]);
      return true;
    }
  }
  return false;
}
