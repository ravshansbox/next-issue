import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, roles } from './harness.mts';

test('a user who asks to stop during the implementation gets the run stopped before the push, with the state kept', async (t) => {
  const target = await harness(t, { pressDuring: 'implementer' });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal(target.pushes, 0);
  assert.equal((await target.state())?.phase, 'implemented');
  assert.equal(target.labels.at(-1)?.label, 'status:in-progress');
});

test('a user who asks to stop during the fix of main gets the fix landed first', async (t) => {
  const target = await harness(t, { pressDuring: 'fixer', baseChecks: ['fail', 'pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.deepEqual(target.landed, ['2', '4']);
});

test('a user who asks to stop during a review round gets the fix and no next review', async (t) => {
  const target = await harness(t, {
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.equal((await target.state())?.reviewRounds, 1);
  assert.equal(target.labels.at(-1)?.label, 'status:in-review');
});

test('a user who stops a run now during the implementation gets the issue stopped with no hand-over and the state kept', async (t) => {
  const target = await harness(t, { stopNowDuring: 'implementer' });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.comments, []);
  assert.equal((await target.state())?.handedOver, undefined);
  assert.equal(target.labels.at(-1)?.label, 'status:in-progress');
});
