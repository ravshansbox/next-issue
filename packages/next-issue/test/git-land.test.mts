import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChildren, stopRunChildren, withRunChildren } from '../src/shared/children.mts';
import { HookError } from '../src/shared/git-commit.mts';
import {
  baseMoved,
  deleteRemoteBranch,
  pushBranch,
  pushToBase,
  reapplyRevert,
  type Revert,
  revertOnBase,
  squashOnto,
} from '../src/shared/git-land.mts';
import { commitMerge, startMerge } from '../src/shared/git-merge.mts';
import { isLanded, isOnBase, type Repo } from '../src/shared/git.mts';
import { addWorktree } from '../src/shared/worktree.mts';
import { clones, commit, git } from './clones.mts';

async function branch(): Promise<{ path: string; other: string; repo: Repo }> {
  const { repo, other } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await commit(path, 'b.txt');
  await commit(path, 'c.txt');
  return { path, other, repo };
}

test('the worker squashes the change into one commit on top of the base and lands it there', async () => {
  const { path, other } = await branch();
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const before = await git(path, 'rev-parse', 'HEAD');
  assert.deepEqual((await startMerge(path, 'main', 'origin')).files, []);
  const merge = { before, target: 'origin/main', files: [] };
  assert.equal(await commitMerge(path, merge, 'chore: merge'), true);
  assert.equal(await squashOnto(path, 'origin/main', 'feat: add b and c'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'feat: add b and c');
  assert.equal((await pushToBase(path, 'origin', 'main')).pushed, true);
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'rev-parse', 'HEAD'), await git(path, 'rev-parse', 'HEAD'));
});

test('the worker pushes the issue branch, pushes it again after a squash rewrote it, and deletes it from the remote', async () => {
  const { path, other, repo } = await branch();
  assert.equal((await pushBranch(path, 'origin', '3', '')).pushed, true);
  const first = await git(path, 'rev-parse', 'HEAD');
  await git(other, 'fetch', '-q', 'origin');
  assert.equal(await git(other, 'rev-parse', 'origin/3'), first);
  assert.equal(await squashOnto(path, 'origin/main', 'feat: add b and c'), true);
  assert.equal((await pushBranch(path, 'origin', '3', first)).pushed, true);
  await git(other, 'fetch', '-q', 'origin');
  assert.equal(await git(other, 'rev-parse', 'origin/3'), await git(path, 'rev-parse', 'HEAD'));
  assert.equal(
    await deleteRemoteBranch(repo, 'origin', '3', await git(path, 'rev-parse', 'HEAD')),
    true,
  );
  await git(other, 'fetch', '-q', '--prune', 'origin');
  await assert.rejects(git(other, 'rev-parse', '--verify', 'origin/3'));
});

test('the worker pushes the issue branch even when a pre-push hook of the project would refuse it', async () => {
  const { path, other } = await branch();
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\necho work in progress >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-push'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  assert.equal((await pushBranch(path, 'origin', '3', '')).pushed, true);
  await git(other, 'fetch', '-q', 'origin');
  assert.equal(await git(other, 'rev-parse', 'origin/3'), await git(path, 'rev-parse', 'HEAD'));
});

test('the worker makes no squash commit for a change that the base already holds', async () => {
  const { path } = await branch();
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  const head = await git(path, 'rev-parse', 'HEAD');
  assert.equal(await squashOnto(path, 'origin/main', 'feat: nothing'), false);
  assert.equal(await git(path, 'rev-parse', 'HEAD'), head);
});

test('the worker squashes a change made only of new untracked files', async () => {
  const { path } = await branch();
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  await writeFile(join(path, 'new.txt'), 'new\n');
  assert.equal(await squashOnto(path, 'origin/main', 'feat: add new'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'show', '--format=', '--name-only', 'HEAD'), 'new.txt');
});

test('the worker keeps the branch head when a pre-commit hook stops the squash, and a retry still squashes onto the base', async () => {
  const { path } = await branch();
  const head = await git(path, 'rev-parse', 'HEAD');
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho lint fails >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  await assert.rejects(squashOnto(path, 'origin/main', 'feat: add b and c'), HookError);
  assert.equal(await git(path, 'rev-parse', 'HEAD'), head);
  assert.equal(await isLanded(path, 'main', 'origin'), false);
  await rm(join(hooks, 'pre-commit'));
  assert.equal(await squashOnto(path, 'origin/main', 'feat: add b and c'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'feat: add b and c');
});

test('the worker refuses to push a change that is behind the base', async () => {
  const { path, other } = await branch();
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const push = await pushToBase(path, 'origin', 'main');
  assert.equal(push.pushed, false);
  assert.match(push.error, /rejected/);
  await git(path, 'fetch', '-q', 'origin');
  assert.equal(await baseMoved(path, 'main', 'origin'), true);
});

test('the worker gets the error of git when the remote refuses a push on an unchanged base, and sees the base did not move', async () => {
  const { path } = await branch();
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\necho permission denied >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-push'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  const push = await pushToBase(path, 'origin', 'main');
  assert.equal(push.pushed, false);
  assert.match(push.error, /permission denied/);
  await git(path, 'fetch', '-q', 'origin');
  assert.equal(await baseMoved(path, 'main', 'origin'), false);
});

test('the worker pushes a revert to the base and leaves the change on the branch on top of it', async () => {
  const { path, other } = await branch();
  await squashOnto(path, 'origin/main', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  const landed = await git(path, 'rev-parse', 'HEAD');
  const saved: string[] = [];
  const pushed = await revertOnBase(path, {
    base: 'main',
    remote: 'origin',
    branch: '3',
    shas: [landed],
    message: 'revert: issue #3',
    reapply: 'feat: add b and c',
    pushing: async (sha) => {
      saved.push(sha);
    },
  });
  assert.equal(pushed, 'pushed');
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'log', '-1', '--format=%s'), 'revert: issue #3');
  assert.deepEqual(saved, [await git(other, 'rev-parse', 'HEAD')]);
  await assert.rejects(readFile(join(other, 'b.txt')));
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(other, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'b.txt\n');
});

test('the worker puts the reverted change back on a branch that the base reset, and leaves a branch that already holds it', async () => {
  const { path } = await branch();
  await squashOnto(path, 'origin/main', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  await git(path, 'checkout', '-q', '--detach');
  await git(path, 'revert', '--no-edit', 'HEAD');
  await pushToBase(path, 'origin', 'main');
  const reverted = await git(path, 'rev-parse', 'HEAD');
  await git(path, 'checkout', '-q', '-B', '3', reverted);
  const reapply = {
    base: 'main',
    remote: 'origin',
    branch: '3',
    reverted,
    reapply: 'feat: add b and c',
  };
  assert.equal(await reapplyRevert(path, reapply), true);
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), reverted);
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'b.txt\n');
  const head = await git(path, 'rev-parse', 'HEAD');
  assert.equal(await reapplyRevert(path, reapply), false);
  assert.equal(await git(path, 'rev-parse', 'HEAD'), head);
});

test('the worker puts the branch back as it was when it cannot push a revert', async () => {
  const { path, other } = await branch();
  await squashOnto(path, 'origin/main', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  const landed = await git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, 'stray.txt'), 'x\n');
  await git(other, 'pull', '-q', 'origin', 'main');
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(path, 'remote', 'set-url', '--push', 'origin', join(path, 'missing.git'));
  const pushed = await revertOnBase(path, {
    base: 'main',
    remote: 'origin',
    branch: '3',
    shas: [landed],
    message: 'revert: issue #3',
    reapply: 'feat: add b and c',
    pushing: async () => {},
  });
  assert.equal(pushed, 'failed');
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), landed);
});

async function landed(): Promise<{ path: string; other: string; sha: string }> {
  const { path, other } = await branch();
  await squashOnto(path, 'origin/main', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  const sha = await git(path, 'rev-parse', 'HEAD');
  await git(other, 'pull', '-q', 'origin', 'main');
  return { path, other, sha };
}

function revertOf(sha: string): Revert {
  return {
    base: 'main',
    remote: 'origin',
    branch: '3',
    shas: [sha],
    message: 'revert: issue #3',
    reapply: 'feat: add b and c',
    pushing: async () => {},
  };
}

test('the worker aborts a revert that conflicts with the base and puts the branch back', async () => {
  const { path, other, sha } = await landed();
  await writeFile(join(other, 'b.txt'), 'changed\n');
  await git(other, 'commit', '-q', '-am', 'change b');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.equal(await revertOnBase(path, revertOf(sha)), 'failed');
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), sha);
  assert.equal(await git(path, 'status', '--porcelain'), '');
  await assert.rejects(git(path, 'rev-parse', '-q', '--verify', 'REVERT_HEAD'));
});

test('the worker pushes nothing for a change that the base already reverted and puts the change back on the branch on top of the base', async () => {
  const { path, other, sha } = await landed();
  await git(other, 'revert', '--no-edit', sha);
  await git(other, 'push', '-q', 'origin', 'main');
  const base = await git(other, 'rev-parse', 'HEAD');
  assert.equal(await revertOnBase(path, revertOf(sha)), 'already reverted');
  await git(other, 'fetch', '-q', 'origin');
  assert.equal(await git(other, 'rev-parse', 'origin/main'), base);
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), base);
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'feat: add b and c');
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'b.txt\n');
  assert.equal(await git(path, 'status', '--porcelain'), '');
});

async function failCommits(path: string): Promise<void> {
  await git(path, 'config', 'commit.gpgSign', 'true');
  await git(path, 'config', 'gpg.program', 'false');
}

test('the worker puts the branch back when the revert commit fails', async () => {
  const { path, sha } = await landed();
  await failCommits(path);
  await assert.rejects(revertOnBase(path, revertOf(sha)));
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), sha);
});

test('the worker reports the commit error when the revert commit fails and the branch cannot be checked out again', async () => {
  const { path, sha } = await landed();
  await failCommits(path);
  await assert.rejects(
    revertOnBase(path, { ...revertOf(sha), branch: 'missing' }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /missing/);
      assert.match(error.message, /commit/);
      return true;
    },
  );
});

test('the worker reports the stop and puts the branch back when the run stops before the revert push', async () => {
  const { path, sha } = await landed();
  const children = runChildren();
  const pushing = async () => stopRunChildren(children);
  await assert.rejects(
    withRunChildren(children, () => revertOnBase(path, { ...revertOf(sha), pushing })),
    /The run stopped\./,
  );
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), sha);
});

test('the worker retries a revert push that loses a race on the new base tip', async () => {
  const { path, other, sha } = await landed();
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  const marker = join(hooks, 'raced');
  await writeFile(
    join(hooks, 'pre-push'),
    [
      '#!/bin/sh',
      `[ -f '${marker}' ] && exit 0`,
      `touch '${marker}'`,
      'unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE',
      `git -C '${other}' -c user.name=t -c user.email=t@t commit -q --allow-empty -m race`,
      `git -C '${other}' push -q origin main`,
      '',
    ].join('\n'),
  );
  await chmod(join(hooks, 'pre-push'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  assert.equal(await revertOnBase(path, revertOf(sha)), 'pushed');
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'log', '-2', '--format=%s'), 'revert: issue #3\nrace');
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(other, 'rev-parse', 'HEAD'));
});

async function pushLandsAndFails(path: string, after = ''): Promise<void> {
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(
    join(hooks, 'pre-push'),
    [
      '#!/bin/sh',
      'git push -q --no-verify origin HEAD:refs/heads/main || exit 0',
      after,
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(join(hooks, 'pre-push'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
}

test('the worker treats a revert as landed when its push lands although git push reports a failure', async () => {
  const { path, other, sha } = await landed();
  await pushLandsAndFails(path);
  assert.equal(await revertOnBase(path, revertOf(sha)), 'pushed');
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'log', '-2', '--format=%s'), 'revert: issue #3\nfeat: add b and c');
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(other, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'b.txt\n');
});

test('the worker does not report a revert as landed when its push reports a failure and the fetch of the base fails', async () => {
  const { path, sha } = await landed();
  await pushLandsAndFails(path, `git config remote.origin.url '${join(path, 'missing.git')}'`);
  await assert.rejects(revertOnBase(path, revertOf(sha)));
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), sha);
});

test('the worker tells a branch whose head the base already holds from one with a commit the base lacks', async () => {
  const { path, other } = await branch();
  assert.equal(await isLanded(path, 'main', 'origin'), false);
  assert.equal((await pushToBase(path, 'origin', 'main')).pushed, true);
  await commit(other, 'd.txt');
  await git(other, 'pull', '-q', '--rebase', 'origin', 'main');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(path, 'fetch', '-q', 'origin');
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  assert.equal(await isLanded(path, 'main', 'origin'), true);
  await commit(path, 'e.txt');
  assert.equal(await isLanded(path, 'main', 'origin'), false);
});

test('the worker fetches the base and tells a commit pushed from elsewhere from one the base lacks', async () => {
  const { path, other } = await branch();
  const sha = await git(path, 'rev-parse', 'HEAD');
  assert.equal(await isOnBase(path, 'main', 'origin', sha), false);
  await git(path, 'push', '-q', other, 'HEAD:refs/heads/landed');
  await git(other, 'push', '-q', 'origin', 'landed:main');
  assert.equal(await isOnBase(path, 'main', 'origin', sha), true);
});
