import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mts';

test('a check wait that runs out of time hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.reason, 'checks timeout');
});

test('a person who pushes to the pull request during the check wait gets the issue handed over', async (t) => {
  const target = await harness(t, { checks: ['moved'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'pull request moved');
});

test('a repository without checks goes straight to the review', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  assert.equal((await target.run()).outcome, 'done');
});

test('the checks wait for the commit that was pushed', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.head),
    ['1', '2', '2'],
  );
});

test('a repository without checks pays the grace time once', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.graceMs),
    [60_000, 0],
  );
});
