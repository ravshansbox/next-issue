import { evenWhenStopped } from './children.mts';
import { run, succeeded } from './exec.mts';
import {
  fetchBase,
  git,
  isAncestor,
  isDirty,
  isLanded,
  isOnBase,
  oneFetchAtATime,
  remoteRef,
  type Repo,
  revision,
  succeeds,
} from './git.mts';
import { commitEverything } from './git-commit.mts';

export const PUSH_TRIES = 3;

export async function squashOnto(cwd: string, target: string, message: string): Promise<boolean> {
  if ((await succeeds(cwd, ['diff', '--quiet', target])) && !(await isDirty(cwd))) {
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

type Push = { pushed: true } | { pushed: false; error: string };

export async function pushToBase(cwd: string, remote: string, base: string): Promise<Push> {
  const result = await oneFetchAtATime(() =>
    run('git', ['push', remote, `HEAD:refs/heads/${base}`], { cwd }),
  );
  return succeeded(result) ? { pushed: true } : { pushed: false, error: result.stderr };
}

export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  expected: string,
): Promise<Push> {
  const ref = `refs/heads/${branch}`;
  const lease = `--force-with-lease=${ref}:${expected}`;
  const result = await oneFetchAtATime(() =>
    run('git', ['push', '--no-verify', lease, remote, `HEAD:${ref}`], { cwd }),
  );
  return succeeded(result) ? { pushed: true } : { pushed: false, error: result.stderr };
}

export async function deleteRemoteBranch(
  repo: Repo,
  remote: string,
  branch: string,
  expected: string,
): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  const lease = `--force-with-lease=${ref}:${expected}`;
  const result = await oneFetchAtATime(() =>
    run('git', ['push', lease, remote, '--delete', ref], { cwd: repo.root }),
  );
  return succeeded(result);
}

export async function baseMoved(cwd: string, base: string, remote: string): Promise<boolean> {
  return !(await isAncestor(cwd, remoteRef(remote, base), 'HEAD'));
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

type Reverted = 'pushed' | 'failed' | 'already reverted';

export async function revertOnBase(cwd: string, revert: Revert): Promise<Reverted> {
  try {
    const reverted = await pushRevert(cwd, revert);
    if (reverted !== 'failed') {
      return reverted;
    }
  } catch (error) {
    await putBranchBack(cwd, revert.branch).catch(() => undefined);
    throw error;
  }
  await putBranchBack(cwd, revert.branch);
  return 'failed';
}

function putBranchBack(cwd: string, branch: string): Promise<void> {
  return evenWhenStopped(async () => {
    await succeeds(cwd, ['revert', '--abort']);
    await succeeds(cwd, ['cherry-pick', '--abort']);
    await git(cwd, ['checkout', '--force', branch]);
  });
}

type Reapply = Pick<Revert, 'base' | 'remote' | 'branch' | 'reapply'> & {
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
  await commitOnBranch(cwd, message, branch);
}

async function commitOnBranch(cwd: string, message: string, branch: string): Promise<void> {
  await git(cwd, ['commit', '--no-verify', '-m', message]);
  await git(cwd, ['checkout', '-B', branch]);
}

async function pushRevert(cwd: string, revert: Revert): Promise<Reverted> {
  const { base, remote, branch, shas, message, reapply, pushing } = revert;
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
    const target = await fetchBase(cwd, base, remote);
    await git(cwd, ['checkout', '--force', '--detach', target]);
    await git(cwd, ['clean', '-fd']);
    if (!(await succeeds(cwd, ['revert', '--no-commit', ...shas.toReversed()]))) {
      return 'failed';
    }
    if (await succeeds(cwd, ['diff', '--cached', '--quiet', 'HEAD'])) {
      await git(cwd, ['revert', '--abort']);
      await git(cwd, ['cherry-pick', '--no-commit', ...shas]);
      await commitOnBranch(cwd, reapply, branch);
      return 'already reverted';
    }
    await git(cwd, ['commit', '--no-verify', '-m', message]);
    const reverted = await revision(cwd);
    await pushing(reverted);
    if (
      (await pushToBase(cwd, remote, base)).pushed ||
      (await isOnBase(cwd, base, remote, reverted))
    ) {
      await commitReapply(cwd, reverted, reapply, branch);
      return 'pushed';
    }
  }
  return 'failed';
}
