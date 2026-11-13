import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mts';

test('a user whose checks on main run out of time gets the issue handed to a person', async (t) => {
  const target = await harness(t, { baseChecks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.reason, 'main checks timeout');
});

test('a user whose repository has no checks gets the landed change done', async (t) => {
  const target = await harness(t, { baseChecks: ['none'] });
  assert.equal((await target.run()).outcome, 'done');
});

test('a user whose change lands gets the checks of the pushed commit on the base branch waited for, and none before the review', async (t) => {
  const target = await harness(t, { baseChecks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(target.baseWaits, target.landed);
});
