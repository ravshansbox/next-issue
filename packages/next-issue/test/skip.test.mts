import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

test('a skipped issue does nothing', async (t) => {
  const target = await harness(t, { issue: { ...ISSUE, labels: [] } });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('an issue with an open blocker waits without a claim', async (t) => {
  const target = await harness(t, { blockers: ['#3', 'acme/other#9'] });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.context.recorder.summary().counts['issue.skip'], 1);
});

test('a saved issue carries on although a blocker is open', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: SAVED,
    blockers: ['#3'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a blocker read that fails gives the error outcome without a claim', async (t) => {
  const target = await harness(t, { fail: 'openBlockers' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('a needs-human issue whose comments cannot be read gives the error outcome without a claim', async (t) => {
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
