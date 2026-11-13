import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/pipeline.mts';
import { APPROVE, changes, harness, ISSUE, roles, stages } from './harness.mts';

test('a clean run implements, reviews and finishes', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reason, undefined);
  assert.equal(report.pr, undefined);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.equal(target.pushes, 0);
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

test('a base that stays behind goes to the log', async (t) => {
  const target = await harness(t, { baseUpdated: false });
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});

test('a base that the harness fast-forwards writes no such event', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], undefined);
});

test('the status labels go to the issue alone', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.labels, [
    { kind: 'issue', number: 7, label: 'status:in-progress' },
    { kind: 'issue', number: 7, label: 'status:in-review' },
    { kind: 'issue', number: 7, label: 'status:done' },
  ]);
});

test('a step that throws gives the error outcome and hands the issue over', async (t) => {
  const target = await harness(t, { fail: 'pushToBase' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.phase, 'review');
});

test('a new issue asks for its worktree to start from the base branch', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.starts, [true]);
});

test('a watcher sees each limited round with its count and its limit', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'oxlint: x is never used', true, true],
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(
    stages(target).filter((stage) => /\//.test(stage)),
    ['review 1/5', 'review fix 1/5', 'commit fix 1/10', 'review 2/5', 'checks fix 1/5'],
  );
});

test('an agent that commits its own work counts as progress', async (t) => {
  const target = await harness(t, { commits: [false], selfCommit: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.landed.length, 1);
});
