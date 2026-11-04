import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, roles } from './harness.mts';

test('a fixer that reports an unrelated failure hands over without a commit', async (t) => {
  const target = await harness(t, {
    checks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, []);
  assert.match(
    target.comments.at(-1)!,
    /a reason this change did not cause: product-inventories fails on main too/,
  );
});

test('a fixer that disputes a finding keeps the round going', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.comments[1]!, /### Fixer: no change\n\nthe count follows the convention/);
});

test('a fixer that disputes and leaves a change hands the issue to a person', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.comments.at(-1)!, /left a change behind: the count follows the convention/);
});

test('a fixer that disputes after its own commit hands the issue to a person', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.equal(target.pushes, 1);
});

test('a fixer that disputes after its own commit gets the commit moved off the branch of the pull request', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.equal(target.head(), '2');
});

test('a fixer that reports an unrelated failure after its own commit gets the commit moved off the branch of the pull request', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    checks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.equal(target.head(), '2');
});

test('a finished issue gets the dispute branches of an earlier run deleted', async (t) => {
  const target = await harness(t, { disputes: ['7-dispute-3'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.deleted, ['7', '7-dispute-3']);
});

test('a fixer that disputes and leaves only an unclean worktree keeps the branch as it is', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  assert.deepEqual(target.asides, []);
});

test('the next reviewer reads the dispute of the fixer', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === 'reviewer')[1]!.prompt;
  assert.match(
    second,
    /The fixer disputed every finding of this round: the count follows the convention in CONTRIBUTING\.md/,
  );
});

test('a reviewer that holds to a disputed finding sends it back to the fixer until the review budget runs out', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), changes('The count is wrong.')],
    fixerText: [
      'unrelated: the count follows the convention in CONTRIBUTING.md',
      'unrelated: the count follows the convention in CONTRIBUTING.md',
    ],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer', 'fixer']);
});
