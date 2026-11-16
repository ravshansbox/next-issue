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
  assert.match(
    target.comments.at(-1)!,
    /disputed the findings: the count follows the convention in CONTRIBUTING.md The fixer left a change behind;/,
  );
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

test('a fixer that fixes the finding and writes a placeholder resolved line keeps its fix', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['Fixed the count.\nresolved: none\ncommit: fix: correct the count'],
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

test('a review fixer that disputes and leaves edits gets them saved in a dispute branch that the hand-over names', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    ...DISPUTED,
  });
  const report = await target.run();
  assert.equal(report.reason, 'dispute with changes');
  assert.equal(target.saves, 1);
  assert.deepEqual(target.asides, [{ target: '1', branch: '7-dispute-2' }]);
  assert.equal(target.head(), '1');
  assert.match(
    target.comments.at(-1)!,
    /The fixer left a change behind; it is saved in the branch `7-dispute-2`\./,
  );
});

test('a review fixer that disputes after its own commit gets a hand-over that names the dispute branch', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    ...DISPUTED,
  });
  await target.run();
  assert.equal(target.saves, 0);
  assert.match(target.comments.at(-1)!, /saved in the branch `7-dispute-3`\./);
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

test('a check fixer that reports an unrelated failure on main and leaves edits gets them saved in a dispute branch that the hand-over names', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    baseChecks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(target.saves, 1);
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.match(
    target.comments.at(-1)!,
    /The fixer left a change behind; it is saved in the branch `7-dispute-3`\./,
  );
});

test('a check fixer that reports an unrelated failure on main after its own commit gets a hand-over that names the dispute branch', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    baseChecks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  await target.run();
  assert.equal(target.saves, 0);
  assert.match(target.comments.at(-1)!, /saved in the branch `7-dispute-4`\./);
});

test('a check fixer that reports an unrelated failure on main and leaves nothing gets a hand-over that names no branch', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  await target.run();
  assert.deepEqual(target.asides, []);
  assert.doesNotMatch(target.comments.at(-1)!, /dispute|left a change/);
});

const REFUSED = {
  fixerWrites: true,
  baseChecks: ['fail' as const],
  baseLogs: 'not ok 3 - /home/runner/work/tool/tool/test/local-checks.test.mts:126:5',
  changedFiles: ['test/local-checks.test.mts'],
  fixerText: 'unrelated: local-checks.test.mts is a known flaky test',
};

test('a check fixer whose unrelated claim is refused after it leaves edits gets a hand-over at the end of the budget that names the dispute branch', async (t) => {
  const target = await harness(t, { ...REFUSED, config: { maxCiFixes: 1 } });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.match(
    target.comments.at(-1)!,
    /The fixer left a change behind; it is saved in the branch `7-dispute-3`\./,
  );
});

test('a check fixer whose unrelated claims are refused in two rounds gets a hand-over that names the dispute branch of each round', async (t) => {
  const target = await harness(t, { ...REFUSED, config: { maxCiFixes: 2 } });
  await target.run();
  assert.deepEqual(
    target.asides.map((aside) => aside.branch),
    ['7-dispute-3', '7-dispute-4'],
  );
  assert.match(
    target.comments.at(-1)!,
    /The fixer left changes behind; they are saved in the branches `7-dispute-3` and `7-dispute-4`\./,
  );
});

test('a check fixer whose unrelated claim is refused after it leaves edits gets a hand-over that names the dispute branch when the next round adds no commit', async (t) => {
  const target = await harness(t, {
    ...REFUSED,
    fixerText: [REFUSED.fixerText, 'I looked but changed nothing.'],
    commits: [true, false],
    config: { maxCiFixes: 2 },
  });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.match(
    target.comments.at(-1)!,
    /The fixer added no commit for the failed checks on main\..* The fixer left a change behind; it is saved in the branch `7-dispute-3`\./,
  );
});

test('a check fixer whose unrelated claim is refused after it leaves edits gets a hand-over that names the dispute branch when its later fix fails the checks too', async (t) => {
  const target = await harness(t, {
    ...REFUSED,
    baseChecks: ['fail', 'fail'],
    fixerText: [REFUSED.fixerText, 'commit: fix: repair the test'],
    config: { maxCiFixes: 2 },
  });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.match(
    target.comments.at(-1)!,
    /The fixer left a change behind; it is saved in the branch `7-dispute-3`\./,
  );
});
