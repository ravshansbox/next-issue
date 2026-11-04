import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, minor, roles } from './harness.mts';

test('a minor finding starts a fix round', async (t) => {
  const target = await harness(t, { verdicts: [minor('The name is long.'), APPROVE] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.prompts[2]!.prompt, /The name is long\./);
  assert.match(target.comments[0]!, /Review: changes requested/);
});

test('the last review round leaves a minor finding and approves', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 1 },
    verdicts: [minor('The name is long.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.ready, [101]);
  assert.match(target.comments[0]!, /Review: approved/);
  assert.match(target.comments[0]!, /the review budget is spent/);
});

test('the last review round still hands over a blocking finding', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 2 },
    verdicts: [minor('The name is long.'), changes('The count is wrong.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.deepEqual(target.ready, []);
});

test('the fixer sees the findings once in the first round and the history later', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), changes('The name is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  const first = target.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(first, /The count is wrong\./);
  assert.doesNotMatch(first, /Earlier rounds/);
  const second = target.prompts.filter((entry) => entry.role === 'fixer')[1]!.prompt;
  assert.match(second, /## Earlier rounds\nRound 1:\n- The count is wrong\./);
  assert.equal(second.match(/The name is wrong\./g)?.length, 1);
});

test('the later reviewer sees the earlier findings', async (t) => {
  const target = await harness(t, { verdicts: [changes('The count is wrong.'), APPROVE] });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === 'reviewer')[1]!.prompt;
  assert.match(second, /Earlier findings\nRound 1:\n- The count is wrong\./);
});
