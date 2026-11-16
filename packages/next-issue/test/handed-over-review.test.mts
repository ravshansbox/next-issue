import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { clones, git } from './clones.mts';
import { harness, ISSUE } from './harness.mts';
import { remoteMain, useGit, writeFiles } from './real-git.mts';
import { tempDir } from './temp-dir.mts';

async function stoppedReview(t: TestContext): Promise<{ root: string; other: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const first = await harness(t, { root: repo.root, stopNowDuring: 'reviewer' });
  useGit(first, async () => undefined);
  const { ports } = first.context;
  const runAgent = ports.runAgent;
  ports.runAgent = async (recorder, request) => {
    if (request.name === 'reviewer') {
      await writeFiles(request.cwd, { 'reviewer.txt': 'reviewer\n' });
      await git(request.cwd, 'add', '-A');
      await git(request.cwd, 'commit', '-q', '-m', 'reviewer');
    }
    return runAgent(recorder, request);
  };
  assert.equal((await first.run()).outcome, 'stopped');
  return { root: repo.root, other };
}

test('a person who adds a commit to an issue handed over after a stop during the review gets that commit reviewed and landed by the retry', async (t) => {
  const { root, other } = await stoppedReview(t);
  const issue = { ...ISSUE, labels: ['status:in-review'] };
  const failed = await harness(t, {
    root,
    issue,
    config: { setupCommand: 'npm ci' },
    setupCode: 1,
  });
  useGit(failed, async () => undefined);
  assert.equal((await failed.run()).reason, 'setup failed');
  const worktree = await tempDir();
  await git(root, 'worktree', 'add', '-q', worktree, '7');
  await writeFiles(worktree, { 'person.txt': 'person\n' });
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', 'person fix');
  await git(root, 'worktree', 'remove', worktree);
  const retry = await harness(t, { root, issue: { ...ISSUE, labels: [] } });
  useGit(retry, async () => undefined);
  assert.equal((await retry.run()).outcome, 'done');
  const review = retry.prompts.find((entry) => entry.role === 'reviewer');
  assert.match(review?.prompt ?? '', /person\.txt/);
  const landed = await remoteMain(other);
  const files = (await git(other, 'ls-tree', '--name-only', landed)).split('\n');
  assert.deepEqual(files, ['a.txt', 'implementer.txt', 'person.txt']);
});

test('a user who stops a run during the review and resumes it gets the reviewer commit thrown away and only the change landed', async (t) => {
  const { root, other } = await stoppedReview(t);
  const resumed = await harness(t, { root, issue: { ...ISSUE, labels: ['status:in-review'] } });
  useGit(resumed, async () => undefined);
  assert.equal((await resumed.run()).outcome, 'done');
  const landed = await remoteMain(other);
  const files = (await git(other, 'ls-tree', '--name-only', landed)).split('\n');
  assert.deepEqual(files, ['a.txt', 'implementer.txt']);
});
