import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

test('the worker does nothing with a skipped issue', async (t) => {
  const target = await harness(t, { issue: { ...ISSUE, labels: [] } });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('the worker leaves an issue with an open blocker waiting without a claim', async (t) => {
  const target = await harness(t, { blockers: ['#3', 'acme/other#9'] });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.context.recorder.summary().counts['issue.skip'], 1);
});

test('the worker carries on with a saved issue although a blocker is open', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: SAVED,
    blockers: ['#3'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['reviewer']);
});

test('the worker reports an error without a claim when the blocker read fails', async (t) => {
  const target = await harness(t, { fail: 'openBlockers' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('the worker reports an error without a claim when the comments of a needs-human issue cannot be read', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    fail: 'threadComments',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('a user whose issue holds the ready label in another case sees it claimed and handled', async (t) => {
  const target = await harness(t, { issue: { ...ISSUE, labels: ['Status:Todo'] } });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
});

test('a user whose issue holds a stop or in-flight label in another case sees it skipped', async (t) => {
  for (const label of [
    'Status:Done',
    'Status:Blocked',
    'Status:Needs-Human',
    'Status:In-Progress',
    'Status:In-Review',
  ]) {
    const target = await harness(t, { issue: { ...ISSUE, labels: ['status:todo', label] } });
    const report = await target.run();
    assert.equal(report.outcome, 'skipped', label);
    assert.deepEqual(roles(target), [], label);
  }
});
