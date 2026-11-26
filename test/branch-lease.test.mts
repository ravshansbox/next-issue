import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { AgentRequest } from '../src/shared/agents.mts';
import { deleteRemoteBranch, pushBranch } from '../src/shared/git-land.mts';
import type { Recorder } from '../src/shared/observe.mts';
import { clones, commit, git } from './clones.mts';
import { changes, type Harness, harness, type Plan } from './harness.mts';
import { landedNames, useGit } from './real-git.mts';

test('a person who pushes a commit to branch 7 during a run keeps it on the remote after a full fetch and after the landing, and the worker logs the refused push and kept branch and still lands the issue', async (t) => {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const target = await harness(t, { root: repo.root });
  useGit(target, async () => undefined);
  const { ports } = target.context;
  const agent = ports.runAgent;
  let personal = '';
  Object.assign(ports, {
    deleteRemoteBranch,
    pushBranch,
    runAgent: async (recorder: Recorder, request: AgentRequest) => {
      if (request.name === 'reviewer') {
        await git(other, 'fetch', '-q', 'origin');
        await git(other, 'checkout', '-q', '-B', '7', 'origin/7');
        personal = await commit(other, 'person.txt');
        await git(other, 'push', '-q', 'origin', '7');
        await git(repo.root, 'fetch', '-q', '--prune', 'origin');
      }
      return agent(recorder, request);
    },
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.equal(
    await git(other, 'ls-remote', 'origin', 'refs/heads/7'),
    `${personal}\trefs/heads/7`,
  );
  const failures = target.events.filter((record) => record.kind === 'branch.push-fail');
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]!.error), /stale info/);
  assert.ok(target.events.some((record) => record.kind === 'branch.remote-kept'));
});

async function resumeAfterPersonalPush(
  t: TestContext,
  stopped: Partial<Plan>,
): Promise<{ resumed: Harness; other: string; personal: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const first = await harness(t, { root: repo.root, ...stopped });
  useGit(first, async () => undefined);
  Object.assign(first.context.ports, { pushBranch });
  assert.equal((await first.run()).outcome, 'stopped');
  await git(other, 'fetch', '-q', 'origin');
  await git(other, 'checkout', '-q', '-B', '7', 'origin/7');
  const personal = await commit(other, 'person.txt');
  await git(other, 'push', '-q', 'origin', '7');
  const resumed = await harness(t, { root: repo.root, saved: await first.state() });
  useGit(resumed, async () => undefined);
  Object.assign(resumed.context.ports, { pushBranch });
  assert.equal((await resumed.run()).outcome, 'done');
  return { resumed, other, personal };
}

test('a worker that resumes an issue after a person pushed a commit on top of its branch push lands that commit and backs up its later commits without a refused push', async (t) => {
  const { resumed, other } = await resumeAfterPersonalPush(t, {
    stopNowDuring: 'fixer',
    verdicts: [changes('The count is wrong.')],
  });
  assert.deepEqual(
    resumed.events.filter((record) => record.kind === 'branch.push-fail'),
    [],
  );
  assert.ok((await landedNames(other)).includes('person.txt'));
});

test('a worker that resumes a stopped review after a person pushed to branch 7 leaves that commit on the remote', async (t) => {
  const { resumed, other, personal } = await resumeAfterPersonalPush(t, {
    stopNowDuring: 'reviewer',
  });
  assert.equal(
    await git(other, 'ls-remote', 'origin', 'refs/heads/7'),
    `${personal}\trefs/heads/7`,
  );
  const failures = resumed.events.filter((record) => record.kind === 'branch.push-fail');
  assert.match(String(failures[0]!.error), /stale info/);
});
