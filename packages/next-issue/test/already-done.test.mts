import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { clones, git } from './clones.mts';
import { APPROVE, changes, harness, ISSUE, type Plan } from './harness.mts';
import { landedFiles, useGit, writeFiles } from './real-git.mts';

const DONE = 'I changed nothing.\ndone: src/flag.mts already reads the flag at line 12.';
const DONE_NOTE =
  '### next-issue · Worker: already done\n\nsrc/flag.mts already reads the flag at line 12.\n\nReview: Good.';

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
    '### next-issue · Worker: already done\n\nsrc/flag.mts already reads the flag at line 12.\n\nReview: Good.',
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
    '### next-issue · Hand-over: needs help\n\nThe implementer produced no change and said the issue is already done: src/flag.mts already reads the flag at line 12.\n\nThe reviewer disagreed:\n\n- The flag is never read.',
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

test('a user whose worker is killed while it posts the already done comment gets the next run to post the comment and close the issue as done with no second review', async (t) => {
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
  assert.deepEqual(resumed.issueNotes, [{ number: 7, body: DONE_NOTE }]);
});

async function doneThenReviewer(
  t: TestContext,
  plan: Plan,
  reviewer: (worktree: string) => Promise<void>,
): Promise<{ root: string; other: string; outcome: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const first = await harness(t, { root: repo.root, implementerText: [DONE], ...plan });
  const { ports } = first.context;
  const fake = ports.runAgent;
  useGit(first, async () => undefined);
  const real = ports.runAgent;
  ports.runAgent = async (recorder, request) => {
    if (request.name === 'implementer') {
      return fake(recorder, request);
    }
    await writeFiles(request.cwd, { 'a.txt': 'reviewer\n', 'reviewer.txt': 'reviewer\n' });
    await git(request.cwd, 'add', 'reviewer.txt');
    await git(request.cwd, 'commit', '-q', '-m', 'reviewer');
    await reviewer(request.cwd);
    return real(recorder, request);
  };
  const { outcome } = await first.run();
  return { root: repo.root, other, outcome };
}

test('a person who retries an issue after its already done reviewer edited and committed files and then timed out gets only the change of the next implementer landed', async (t) => {
  const { root, other, outcome } = await doneThenReviewer(t, {}, async () => {
    throw new Error('The reviewer agent did not finish in 60000 ms.');
  });
  assert.equal(outcome, 'error');
  const retry = await harness(t, { root, issue: { ...ISSUE, labels: [] } });
  useGit(retry, async () => undefined);
  assert.equal((await retry.run()).outcome, 'done');
  assert.deepEqual(await landedFiles(other), {
    'a.txt': 'a.txt',
    'implementer.txt': 'implementer',
  });
});

test('a user who resumes an issue after a stop now during the already done reviewer that edited and committed files gets only the change of the next implementer landed', async (t) => {
  const { root, other, outcome } = await doneThenReviewer(
    t,
    { stopNowDuring: 'reviewer' },
    async () => undefined,
  );
  assert.equal(outcome, 'stopped');
  const resumed = await harness(t, {
    root,
    issue: { ...ISSUE, labels: ['status:in-progress'] },
  });
  useGit(resumed, async () => undefined);
  assert.equal((await resumed.run()).outcome, 'done');
  assert.deepEqual(await landedFiles(other), {
    'a.txt': 'a.txt',
    'implementer.txt': 'implementer',
  });
});

test('a user whose already done issue fails to close after its note was posted gets the note posted only once when the answered issue is resumed and closed as done', async (t) => {
  const first = await harness(t, {
    commits: [false],
    implementerText: [DONE],
    verdicts: [APPROVE],
  });
  first.context.ports.closeIssue = async () => {
    throw new Error('gh: HTTP 502');
  };
  assert.equal((await first.run()).outcome, 'error');
  assert.deepEqual(
    first.issueNotes.filter((note) => note.body === DONE_NOTE),
    [{ number: 7, body: DONE_NOTE }],
  );
  const resumed = await harness(t, {
    root: first.context.repo.root,
    issue: { ...ISSUE, labels: [] },
    commits: [false],
    implementerText: [DONE],
    verdicts: [APPROVE],
  });
  assert.equal((await resumed.run()).outcome, 'done');
  assert.deepEqual(resumed.closed, [7]);
  assert.deepEqual(
    resumed.issueNotes.filter((note) => note.body === DONE_NOTE),
    [],
  );
});

test('a user whose worker stops after it marks the already done issue as closing and before it posts the note gets the note posted when the next run closes the issue', async (t) => {
  const first = await harness(t, {
    commits: [false],
    implementerText: [DONE],
    verdicts: [APPROVE],
  });
  first.context.ports.commentOnIssue = async () => {
    first.stopNow();
    throw new Error('The run stopped.');
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.equal((await first.state())?.closing, true);
  const resumed = await harness(t, { root: first.context.repo.root });
  assert.equal((await resumed.run()).outcome, 'done');
  assert.deepEqual(resumed.closed, [7]);
  assert.deepEqual(resumed.prompts, []);
  assert.deepEqual(resumed.issueNotes, [{ number: 7, body: DONE_NOTE }]);
});
