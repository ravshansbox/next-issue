import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, roles } from './harness.mts';

const RESOLVED = 'resolved: the new test failed with the fix reverted and passes with it';
const SETTLED = { verdicts: [changes('Show the test fail.'), APPROVE], fixerText: [RESOLVED] };

test('a fixer that settles every finding with no code change keeps the round going', async (t) => {
  const target = await harness(t, { ...SETTLED });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(
    target.comments[1]!,
    /### Fixer: settled with no change\n\nthe new test failed with the fix reverted/,
  );
});

test('the next reviewer reads the settled note of the fixer', async (t) => {
  const target = await harness(t, { ...SETTLED });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === 'reviewer')[1]!.prompt;
  assert.match(
    second,
    /The fixer settled every finding of this round with no code change: the new test failed/,
  );
});

test('a fixer that settles the findings and leaves a change hands the issue to a person', async (t) => {
  const target = await harness(t, { fixerWrites: true, ...SETTLED });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.match(target.comments.at(-1)!, /left a change behind: the new test failed/);
});

test('a fixer that settles the findings after its own commit gets the commit moved off the branch', async (t) => {
  const target = await harness(t, { selfCommit: true, ...SETTLED });
  const report = await target.run();
  assert.equal(report.reason, 'dispute with changes');
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.deepEqual(target.landed, []);
});

test('a reviewer that repeats a settled finding sends it back to the fixer until the review budget runs out', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 2 },
    verdicts: [changes('Show the test fail.'), changes('Show the test fail.')],
    fixerText: [RESOLVED, RESOLVED],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer', 'fixer']);
});
