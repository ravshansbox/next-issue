import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes, harness, roles } from './harness.mts';

test('the check budget hands the issue to a person', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 1 }, baseChecks: ['fail', 'fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main failed and the limit of 1 check fixes/,
  );
  assert.equal((await target.state())?.phase, 'review');
});

test('a check budget of zero stops before the first fix', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
});

test('the review budget hands the issue to a person', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 1 },
    verdicts: [changes('The count is wrong.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
});

test('a reviewer that repeats the findings of an earlier round starts another fix round until the review budget runs out', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), changes('The count is wrong.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer', 'fixer']);
});
