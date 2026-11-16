import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, type Plan } from './harness.mts';

const DONE = 'I changed nothing.\ndone: src/flag.mts already reads the flag at line 12.';

test('a user whose implementer finds the issue already done on the base and whose reviewer agrees gets the issue closed as done with the evidence in a comment', async (t) => {
  const target = await harness(t, {
    commits: [false],
    implementerText: [DONE],
    verdicts: [APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.deepEqual(target.landed, []);
  assert.equal(
    target.issueNotes.at(-1)!.body,
    '### Already done\n\nsrc/flag.mts already reads the flag at line 12.\n\nReview: Good.',
  );
  const review = target.prompts.find((entry) => entry.role === 'reviewer')!.prompt;
  assert.match(review, /already done on the base/);
  assert.match(review, /src\/flag\.mts already reads the flag at line 12\./);
});

test('a user whose implementer finds the issue already done but whose reviewer disagrees gets the issue handed over with the findings of the reviewer', async (t) => {
  const target = await harness(t, {
    commits: [false],
    implementerText: [DONE],
    verdicts: [changes('The flag is never read.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'already done disputed');
  assert.deepEqual(target.closed, []);
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal(
    target.issueNotes.at(-1)!.body,
    'next-issue needs help: The implementer produced no change and said the issue is already done: src/flag.mts already reads the flag at line 12.\n\nThe reviewer disagreed:\n\n- The flag is never read.',
  );
});

test('a user whose implementer finds the issue already done but whose reviewer gives no verdict gets the issue handed over', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: [DONE], verdicts: [] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'already done disputed');
  assert.deepEqual(target.closed, []);
  assert.match(target.issueNotes.at(-1)!.body, /The reviewer gave no verdict\.$/);
});

test('an implementer that asks questions and also says the issue is done gets its questions handed over and no review', async (t) => {
  const target = await harness(t, {
    implementerText: [`question: 1. Which flag? a) x b) y. I recommend a.\n${DONE}`],
  });
  const report = await target.run();
  assert.equal(report.reason, 'questions');
  assert.deepEqual(target.closed, []);
  assert.ok(target.prompts.every((entry) => entry.role !== 'reviewer'));
});

test('a user whose ready parent issue is blocked by its sub-issues gets it skipped while one is open and closed as done once they have all landed', async (t) => {
  const plan: Plan = {
    blockers: ['#8'],
    commits: [false],
    implementerText: ['done: every sub-issue has landed on the base.'],
  };
  const target = await harness(t, plan);
  assert.equal((await target.run()).outcome, 'skipped');
  assert.deepEqual(target.closed, []);
  plan.blockers = [];
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user whose worker is killed while it posts the already done comment gets the next run to close the issue as done with no second review or comment', async (t) => {
  const first = await harness(t, {
    commits: [false],
    implementerText: [DONE],
    verdicts: [APPROVE],
  });
  let posted = (): void => undefined;
  const posting = new Promise<void>((resolve) => {
    posted = resolve;
  });
  first.context.ports.commentOnIssue = async () => {
    posted();
    return new Promise(() => undefined);
  };
  void first.run();
  await posting;
  const resumed = await harness(t, { root: first.context.repo.root });
  const report = await resumed.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(resumed.closed, [7]);
  assert.deepEqual(resumed.prompts, []);
  assert.deepEqual(resumed.issueNotes, []);
});
