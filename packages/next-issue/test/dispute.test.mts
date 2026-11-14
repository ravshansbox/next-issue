import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, roles } from './harness.mts';

const DISPUTE = 'unrelated: the count follows the convention in CONTRIBUTING.md';
const DISPUTED = { verdicts: [changes('The count is wrong.'), APPROVE], fixerText: [DISPUTE] };

test('a fixer that reports an unrelated failure on main hands over without a commit', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.landed, ['2']);
  assert.deepEqual(target.closed, []);
  assert.match(
    target.comments.at(-1)!,
    /a reason this change did not cause: product-inventories fails on main too/,
  );
});

test('a fixer that disputes a finding keeps the round going', async (t) => {
  const target = await harness(t, {
    ...DISPUTED,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.comments[1]!, /### Fixer: no change\n\nthe count follows the convention/);
});

test('a fixer that disputes and leaves a change hands the issue to a person', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    ...DISPUTED,
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
    ...DISPUTED,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.deepEqual(target.landed, []);
});

test('a fixer that disputes after its own commit gets the commit moved off the branch', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    ...DISPUTED,
  });
  await target.run();
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.equal(target.head(), '2');
});

test('a fixer that reports an unrelated failure on main after its own commit gets the commit moved off the branch', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    baseChecks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.asides, [{ target: '3', branch: '7-dispute-4' }]);
});

test('a fixer that fixes the finding and writes a placeholder unrelated line keeps its fix', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['Fixed the count.\nunrelated: none\ncommit: fix: correct the count'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.deepEqual(target.asides, []);
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
    ...DISPUTED,
  });
  await target.run();
  assert.deepEqual(target.asides, []);
});

test('the next reviewer reads the dispute of the fixer', async (t) => {
  const target = await harness(t, {
    ...DISPUTED,
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
    fixerText: [DISPUTE, DISPUTE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer', 'fixer']);
});
