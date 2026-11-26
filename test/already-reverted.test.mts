import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clones, git } from './clones.mts';
import { harness } from './harness.mts';
import { remoteMain, useGit } from './real-git.mts';

test('a user who reverts a landed change on the base by hand before its checks fail gets the issue handed over saying the change is already reverted, with no revert pushed', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const target = await harness(t, {
    root: repo.root,
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
  });
  useGit(target, async () => {});
  const { ports } = target.context;
  const waitForCiChecks = ports.waitForCiChecks;
  let revertedByHand = '';
  ports.waitForCiChecks = async (...args) => {
    if (revertedByHand !== '') {
      return waitForCiChecks(...args);
    }
    await git(other, 'pull', '-q', 'origin', 'main');
    await git(other, 'revert', '--no-edit', 'HEAD');
    await git(other, 'push', '-q', 'origin', 'main');
    revertedByHand = await remoteMain(other);
    return waitForCiChecks(...args);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(await remoteMain(other), revertedByHand);
  const comment = target.comments.at(-1) ?? '';
  assert.match(
    comment,
    /The change is already reverted on main, so the harness pushed no revert\./,
  );
  assert.doesNotMatch(comment, /revert of the change on main failed/);
});
