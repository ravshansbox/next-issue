import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/worker/pipeline.mts';
import { harness, ISSUE, roles } from './harness.mts';

test('the worker implements, reviews and finishes a clean issue', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reason, undefined);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.landed, ['2']);
  assert.deepEqual(target.closed, [7]);
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ['7']);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a user with several issues at once gets their worktrees made one at a time', async (t) => {
  const target = await harness(t);
  const ports = target.context.ports;
  let active = 0;
  let most = 0;
  const addWorktree = ports.addWorktree;
  ports.addWorktree = async (...args) => {
    active += 1;
    most = Math.max(most, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return addWorktree(...args);
  };
  await Promise.all([
    processIssue(target.context, ISSUE),
    processIssue(target.context, { ...ISSUE, number: 8 }),
  ]);
  assert.deepEqual(target.branches.toSorted(), ['7', '8']);
  assert.equal(most, 1);
});

test('the worker logs a base that stays behind', async (t) => {
  const target = await harness(t, { baseUpdated: false });
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});

test('the worker logs no base.behind event when it fast-forwards the base', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], undefined);
});

test('a user whose issue branch cannot be fast-forwarded to its remote branch finds a branch.behind event in the log', async (t) => {
  const target = await harness(t, { branchUpdated: false });
  await target.run();
  assert.equal(target.context.recorder.summary().counts['branch.behind'], 1);
});

test('the worker puts the status labels on the issue alone', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.labels, [
    { kind: 'issue', number: 7, label: 'status:in-progress' },
    { kind: 'issue', number: 7, label: 'status:in-review' },
    { kind: 'issue', number: 7, label: 'status:done' },
  ]);
});

test('the worker reports an error and hands the issue over when a step throws', async (t) => {
  const target = await harness(t, { fail: 'pushToBase' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.phase, 'approved');
});

test('the worker starts the worktree of a new issue from the base branch', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.starts, [true]);
});

test('an agent that commits its own work counts as progress', async (t) => {
  const target = await harness(t, { commits: [false], selfCommit: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.landed.length, 1);
});
