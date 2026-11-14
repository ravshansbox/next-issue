import { fetchBase, git, remoteRef, revision, succeeds } from './git.mts';
import { commitEverything } from './git-commit.mts';

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
  return succeeds(cwd, ['push', remote, `HEAD:refs/heads/${base}`]);
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
  const { base, remote, branch, shas, message, reapply } = revert;
  const target = await fetchBase(cwd, base, remote);
  await git(cwd, ['checkout', '--force', '--detach', target]);
  await git(cwd, ['clean', '-fd']);
  await git(cwd, ['revert', '--no-commit', ...shas.toReversed()]);
  await git(cwd, ['commit', '--no-verify', '-m', message]);
  if (!(await pushToBase(cwd, remote, base))) {
    await git(cwd, ['checkout', '--force', branch]);
    return false;
  }
  await git(cwd, ['revert', '--no-commit', await revision(cwd)]);
  await git(cwd, ['commit', '--no-verify', '-m', reapply]);
  await git(cwd, ['checkout', '-B', branch]);
  return true;
}
