import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, ISSUE, SAVED } from './harness.mts';

const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };
const BEFORE = { ...SAVED, ciFixes: 1, commitFixes: 1 };
const OLD_THREAD = [
  { author: 'bot', body: 'next-issue needs help: The limit of 1 check fixes was reached.' },
  { author: 'owner', body: 'Use the fixture in test/data.' },
];

type Target = Awaited<ReturnType<typeof harness>>;

function labelFails(target: Target) {
  const setLabel = target.context.ports.setLabel;
  target.context.ports.setLabel = async (repo, kind, number, label, remove) => {
    if (label === 'status:needs-human') {
      throw new Error('gh: API rate limit exceeded');
    }
    return setLabel(repo, kind, number, label, remove);
  };
}

function firstCommentFails(target: Target) {
  const commentOnIssue = target.context.ports.commentOnIssue;
  let failed = false;
  target.context.ports.commentOnIssue = async (repo, issue, body) => {
    if (!failed && body.includes('needs help:')) {
      failed = true;
      throw new Error('gh: HTTP 502');
    }
    return commentOnIssue(repo, issue, body);
  };
}

async function assertResumedWithBudgets(t: test.TestContext, saved: unknown) {
  const kept = saved as typeof BEFORE;
  assert.equal(kept.handedOver, undefined);
  assert.equal(kept.ciFixes, BEFORE.ciFixes);
  assert.equal(kept.commitFixes, BEFORE.commitFixes);
  assert.equal(kept.reviewRounds, BEFORE.reviewRounds);
  assert.deepEqual(kept.reviewLog, BEFORE.reviewLog);
  const next = await harness(t, {
    issue: IN_REVIEW,
    saved: kept,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 2 },
  });
  await next.run();
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')!.prompt;
  assert.doesNotMatch(reviewer, /Answer of a person to the hand-over/);
  assert.match(reviewer, /- old/);
  assert.equal(next.prompts.filter((entry) => entry.role === 'reviewer').length, 1);
}

test('a user whose hand-over fails to set the needs-human label gets the next run to resume the issue with its budgets, findings and no hand-over reply', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    config: { maxReviewRounds: 1 },
  });
  labelFails(target);
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  await assertResumedWithBudgets(t, await target.state());
});

test('a user who stops a run now during a hand-over gets the issue stopped, and the next run resumes it with its budgets, findings and no hand-over reply', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    config: { maxReviewRounds: 1 },
    stopNowOnLabel: 'status:needs-human',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  await assertResumedWithBudgets(t, await target.state());
});

test('a user whose hand-over comment fails sees the original reason in the hand-over comment that posts after it', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    config: { maxReviewRounds: 1 },
  });
  firstCommentFails(target);
  await target.run();
  const handOvers = target.comments.filter((comment) => comment.includes('needs help:'));
  assert.equal(handOvers.length, 1);
  assert.match(handOvers[0]!, /The limit of 1 review rounds was reached\./);
  assert.equal((await target.state())?.handedOver, true);
});

test('a user whose hand-over posts its label and comment gets the next run to reset the budgets and pass on the reply of a person', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    config: { maxReviewRounds: 1 },
  });
  assert.equal((await target.run()).outcome, 'needs-human');
  const saved = (await target.state())!;
  assert.equal(saved.handedOver, true);
  const next = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  await next.run();
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')!.prompt;
  assert.doesNotMatch(reviewer, /- old/);
  const answered = next.prompts.filter(
    (entry) =>
      entry.role === 'fixer' &&
      /## Answer of a person to the hand-over\n\n[^]*Use the fixture in test\/data\./.test(
        entry.prompt,
      ),
  );
  assert.notEqual(answered.length, 0);
  const resumed = await next.state();
  assert.equal(resumed?.ciFixes ?? 0, 0);
});
