import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitingQuestions } from '../src/hand-over-comments.mts';
import { APPROVE, changes, harness, ISSUE, roles, SAVED } from './harness.mts';

const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };
const BEFORE = { ...SAVED, ciFixes: 1, commitFixes: 1 };
const OLD_THREAD = [
  {
    author: 'bot',
    body: '### next-issue · Hand-over: needs help\n\nThe limit of 1 check fixes was reached.',
    url: 'https://github.com/o/r/issues/7#issuecomment-1',
    createdAt: '2026-01-02T00:00:00Z',
  },
  { author: 'owner', body: 'Use the fixture in test/data.', createdAt: '2026-01-03T00:00:00Z' },
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
    if (!failed && body.includes('needs help')) {
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
  const handOvers = target.comments.filter((comment) => comment.includes('needs help'));
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

function commentFails(target: Target) {
  const commentOnIssue = target.context.ports.commentOnIssue;
  target.context.ports.commentOnIssue = async (repo, issue, body) => {
    if (body.includes('needs help')) {
      throw new Error('gh: HTTP 502');
    }
    return commentOnIssue(repo, issue, body);
  };
}

async function labelledWithoutComment(t: test.TestContext) {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 1 },
  });
  commentFails(target);
  assert.equal((await target.run()).outcome, 'error');
  assert.ok(target.labels.some((entry) => entry.label === 'status:needs-human'));
  return target;
}

const WAITING = { ...ISSUE, labels: ['status:needs-human'] };

test('a writer whose answer belongs to an earlier hand-over sees the next pass skip the issue with stop-label when the new hand-over comment failed', async (t) => {
  const first = await labelledWithoutComment(t);
  const next = await harness(t, {
    issue: WAITING,
    saved: (await first.state())!,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
  });
  const report = await next.run();
  assert.equal(report.outcome, 'skipped');
  assert.ok(
    next.events.some((record) => record.kind === 'issue.skip' && record.reason === 'stop-label'),
  );
  assert.deepEqual(roles(next), []);
});

test('a writer who answers after a hand-over whose comment failed gets the next pass to claim the issue, reset the budgets and pass that answer to the fixer', async (t) => {
  const first = await labelledWithoutComment(t);
  const next = await harness(t, {
    issue: WAITING,
    saved: (await first.state())!,
    thread: [
      ...OLD_THREAD,
      { author: 'owner', body: 'Try the other fixture.', createdAt: '2026-01-04T00:00:00Z' },
    ],
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  await next.run();
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')!.prompt;
  assert.doesNotMatch(reviewer, /- old/);
  const fixer = next.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /## Answer of a person to the hand-over\n\n[^]*Try the other fixture\./);
  assert.doesNotMatch(fixer, /Use the fixture in test\/data\./);
  assert.equal((await next.state())?.ciFixes ?? 0, 0);
});

test('the worker keeps in its questions, with the reason of the new hand-over, an issue whose new hand-over comment failed after a writer answered an earlier hand-over', async (t) => {
  const first = await labelledWithoutComment(t);
  const questions = await waitingQuestions(first.context.repo, first.context.config, {
    openIssues: async () => [WAITING],
    threadComments: async () => OLD_THREAD,
    canWrite: async (_repo, login) => ['owner', 'bot'].includes(login),
  });
  assert.deepEqual(
    questions.map((question) => [question.issue, question.reason, question.url]),
    [[WAITING.number, 'The limit of 1 review rounds was reached.', '']],
  );
});

test('a user whose hand-over cannot read the issue thread still gets the needs-human label and comment', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    config: { maxReviewRounds: 1 },
  });
  target.context.ports.threadComments = async () => {
    throw new Error('gh: HTTP 502');
  };
  assert.equal((await target.run()).outcome, 'needs-human');
  assert.ok(target.labels.some((entry) => entry.label === 'status:needs-human'));
  assert.equal((await target.state())?.handedOver, true);
});

const RETRIED = { ...ISSUE, labels: [] };

test('a person who takes the label off a hand-over whose comment failed gets the next run to reset the budgets and run the reviewer instead of handing over', async (t) => {
  const first = await labelledWithoutComment(t);
  const next = await harness(t, {
    issue: RETRIED,
    saved: (await first.state())!,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 1 },
  });
  const report = await next.run();
  assert.notEqual(report.outcome, 'needs-human');
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')?.prompt;
  assert.ok(reviewer !== undefined);
  assert.doesNotMatch(reviewer, /- old/);
  assert.equal((await next.state())?.ciFixes ?? 0, 0);
});

test('a writer who answers a hand-over whose comment failed and then takes the label off gets that answer passed to the agents as the hand-over answer', async (t) => {
  const first = await labelledWithoutComment(t);
  const next = await harness(t, {
    issue: RETRIED,
    saved: (await first.state())!,
    thread: [
      ...OLD_THREAD,
      { author: 'owner', body: 'Try the other fixture.', createdAt: '2026-01-04T00:00:00Z' },
    ],
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  await next.run();
  const fixer = next.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /## Answer of a person to the hand-over\n\n[^]*Try the other fixture\./);
  assert.doesNotMatch(fixer, /Use the fixture in test\/data\./);
});

async function labelledThenRetryFails(t: test.TestContext, threadFails: boolean) {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: BEFORE,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 1 },
  });
  const { ports } = target.context;
  const { commentOnIssue, setLabel, threadComments } = ports;
  let outage = false;
  ports.commentOnIssue = async (repo, issue, body) => {
    if (body.includes('needs help')) {
      outage = true;
      throw new Error('gh: HTTP 502');
    }
    return commentOnIssue(repo, issue, body);
  };
  ports.setLabel = async (repo, kind, number, label, remove) => {
    if (outage && label === 'status:needs-human') {
      throw new Error('gh: HTTP 502');
    }
    return setLabel(repo, kind, number, label, remove);
  };
  ports.threadComments = async (...args) => {
    if (outage && threadFails) {
      throw new Error('gh: HTTP 502');
    }
    return threadComments(...args);
  };
  assert.equal((await target.run()).outcome, 'error');
  assert.ok(target.labels.some((entry) => entry.label === 'status:needs-human'));
  return target;
}

test('a person who takes the label off a hand-over whose comment and retried label edit failed gets the next run to reset the budgets and run the reviewer instead of handing over', async (t) => {
  const first = await labelledThenRetryFails(t, false);
  const next = await harness(t, {
    issue: RETRIED,
    saved: (await first.state())!,
    thread: OLD_THREAD,
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 1 },
  });
  const report = await next.run();
  assert.notEqual(report.reason, 'review budget');
  assert.notEqual(report.outcome, 'needs-human');
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')?.prompt;
  assert.ok(reviewer !== undefined);
  assert.doesNotMatch(reviewer, /- old/);
  assert.equal((await next.state())?.ciFixes ?? 0, 0);
});

test('a writer who answers a hand-over whose comment, retried label edit and retried thread read failed gets the next pass to claim the issue and pass that answer to the fixer', async (t) => {
  const first = await labelledThenRetryFails(t, true);
  const next = await harness(t, {
    issue: WAITING,
    saved: (await first.state())!,
    thread: [
      ...OLD_THREAD,
      { author: 'owner', body: 'Try the other fixture.', createdAt: '2026-01-04T00:00:00Z' },
    ],
    writers: ['owner', 'bot'],
    config: { maxReviewRounds: 2 },
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  await next.run();
  const reviewer = next.prompts.find((entry) => entry.role === 'reviewer')!.prompt;
  assert.doesNotMatch(reviewer, /- old/);
  const fixer = next.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /## Answer of a person to the hand-over\n\n[^]*Try the other fixture\./);
  assert.doesNotMatch(fixer, /Use the fixture in test\/data\./);
  assert.equal((await next.state())?.ciFixes ?? 0, 0);
});
