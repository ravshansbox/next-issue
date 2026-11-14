import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Verdict } from '../src/verdict.mts';
import { APPROVE, changes, harness, roles } from './harness.mts';

const CUT = /\n\nThis comment was too long for GitHub and was cut\.$/;

test('a user whose reviewer approves with a summary longer than a GitHub comment sees the verdict cut to fit and the change lands', async (t) => {
  const long: Verdict = { summary: `Good. ${'x'.repeat(70000)}`, findings: [] };
  const target = await harness(t, { verdicts: [long] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  const body = target.comments[0]!;
  assert.ok(body.length <= 65536);
  assert.match(body, /^### Review: approved\n\nGood\./);
  assert.match(body, CUT);
});

test('a user whose reviewer gives long findings of emoji sees the verdict cut between whole characters', async (t) => {
  const target = await harness(t, { verdicts: [changes(`x${'😀'.repeat(40000)}`), APPROVE] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  const body = target.comments[0]!;
  assert.ok(body.length <= 65536);
  assert.doesNotMatch(body, /\p{Cs}/u);
  assert.match(body, CUT);
});

test('a user whose fixer disputes with a note longer than a GitHub comment sees the fixer comment cut to fit and the next review runs', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: [`unrelated: ${'y'.repeat(70000)}`],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  const body = target.comments[1]!;
  assert.ok(body.length <= 65536);
  assert.match(body, /^### Fixer: no change\n\nyyy/);
  assert.match(body, CUT);
});

test('a user whose fixer settles with a note longer than a GitHub comment sees the fixer comment cut to fit and the next review runs', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Show the test fail.'), APPROVE],
    fixerText: [`resolved: ${'z'.repeat(70000)}`],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  const body = target.comments[1]!;
  assert.ok(body.length <= 65536);
  assert.match(body, /^### Fixer: settled with no change\n\nzzz/);
  assert.match(body, CUT);
});
