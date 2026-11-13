import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Verdict } from '../src/verdict.mts';
import { APPROVE, changes, harness, ISSUE, SAVED } from './harness.mts';

test('a reviewer without a verdict hands the issue to a person', async (t) => {
  const target = await harness(t, { verdicts: [] });
  const report = await target.run();
  assert.equal(report.reason, 'no verdict');
});

test('a reviewer that says request_changes with no finding still approves', async (t) => {
  const target = await harness(t, {
    verdicts: [
      { verdict: 'request_changes', summary: 'Good.', findings: [] } as unknown as Verdict,
    ],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reviewRounds, 1);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a verdict of the wrong shape counts as no verdict', async (t) => {
  const target = await harness(t, {
    verdicts: [{ summary: 'x' } as unknown as Verdict],
  });
  assert.equal((await target.run()).reason, 'no verdict');
});

test('the reviewer can run commands in the worktree', async (t) => {
  const target = await harness(t);
  await target.run();
  const reviewer = target.profiles.find((entry) => entry.role === 'reviewer')!;
  assert.equal(reviewer.tools.includes('-bash'), false);
  assert.match(target.prompts.at(-1)!.prompt, /run commands to prove what you say/);
});

test('a change that the reviewer leaves never reaches a commit', async (t) => {
  const target = await harness(t, {
    reviewerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
});

test('a diff that is too long is cut before the reviewer reads it', async (t) => {
  const target = await harness(t, { config: { diffMaxChars: 20 }, diff: 'x'.repeat(50) });
  assert.equal((await target.run()).outcome, 'done');
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /The diff is cut here, after 20 characters\./);
  assert.equal(prompt.includes('x'.repeat(21)), false);
});

test('a diff that fits reaches the reviewer whole', async (t) => {
  const target = await harness(t, { diff: 'the whole diff' });
  await target.run();
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /the whole diff/);
  assert.equal(prompt.includes('cut here'), false);
});

test('a commit that the reviewer makes does not stay on the branch', async (t) => {
  const target = await harness(t, {
    reviewerCommits: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
  assert.equal(await target.context.ports.revision('worktree'), '3');
});

test('the reviewer gets the reply of the implementer in its prompt', async (t) => {
  const reply = 'The test failed first: expected 2, got 1.\ncommit: fix: count the issues';
  const target = await harness(t, { implementerText: [reply] });
  assert.equal((await target.run()).outcome, 'done');
  const reviewer = target.prompts.find((entry) => entry.role === 'reviewer')!;
  assert.match(
    reviewer.prompt,
    /## Reply of the implementer\nThe test failed first: expected 2, got 1\./,
  );
});

test('a user who resumes a run after the implementer gets its saved reply to the reviewer', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: {
      ...SAVED,
      phase: 'implemented',
      reviewRounds: 0,
      reviewLog: [],
      implementerReply: 'The test failed first.',
    },
  });
  assert.equal((await target.run()).outcome, 'done');
  const reviewer = target.prompts.find((entry) => entry.role === 'reviewer')!;
  assert.match(reviewer.prompt, /## Reply of the implementer\nThe test failed first\./);
});
