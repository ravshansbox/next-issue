import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes, harness, ISSUE, SAVED } from './harness.mts';

test('a fixer that changes nothing and says nothing hands the issue to a person', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.')],
    commits: [true, false],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'no fix commit');
});

test('an implementer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { commits: [false] });
  const report = await target.run();
  assert.equal(report.reason, 'no implementation commit');
  assert.equal(target.pushes, 0);
});

test('a user whose issue is handed over because the implementer made no change sees the reply of the implementer after the note', async (t) => {
  const reply = 'I need answers first.\n\n1. Use A or B? I recommend A.';
  const target = await harness(t, { commits: [false], implementerText: [reply] });
  await target.run();
  assert.equal(
    target.issueNotes[0]!.body,
    `next-issue needs help: The implementer produced no change.\n\n${reply}`,
  );
});

test('a user whose implementer gave a reply too long for a GitHub comment sees it cut to fit with a line that says so', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['x'.repeat(70000)] });
  await target.run();
  const body = target.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.match(body, /^next-issue needs help: The implementer produced no change\.\n\nxxx/);
  assert.match(body, /\n\nThe reason was too long for a GitHub comment and was cut\.$/);
});

test('a user whose implementer gave a long reply of emoji sees it cut between whole characters', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['😀'.repeat(40000)] });
  await target.run();
  const body = target.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.doesNotMatch(body, /\p{Cs}/u);
});

test('a writer who answers a hand-over after a run error with stderr longer than a GitHub comment sees the reason cut to fit and gets the issue claimed again', async (t) => {
  const failed = await harness(t, {
    commits: [new Error(`git hook run pre-commit failed with code 1: ${'e'.repeat(200000)}`)],
  });
  const report = await failed.run();
  assert.equal(report.outcome, 'error');
  const body = failed.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.match(body, /^next-issue needs help: The run failed: git hook run pre-commit failed/);
  assert.match(body, /\n\nThe reason was too long for a GitHub comment and was cut\.$/);
  const answered = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved: await failed.state(),
    thread: [
      { author: 'bot', body },
      { author: 'owner', body: 'Fixed the hook, take it.' },
    ],
    writers: ['owner', 'bot'],
  });
  const resumed = await answered.run();
  assert.equal(resumed.outcome, 'done');
  assert.ok(answered.removable[0]!.includes('status:needs-human'));
});

test('a user whose implementer made no change and gave no reply sees only the note', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['  '] });
  await target.run();
  assert.equal(
    target.issueNotes[0]!.body,
    'next-issue needs help: The implementer produced no change.',
  );
});

test('an implementer that changes nothing on a branch already ahead of the base gets the change landed with the subject of the earlier commit', async (t) => {
  const target = await harness(t, { commits: [false], earlier: 'fix: earlier work' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages.at(-1)!, /^fix: earlier work\n/);
});

test('a user whose issue is handed over before a pull request exists gets the reason as a comment on the issue', async (t) => {
  const target = await harness(t, { commits: [false] });
  await target.run();
  assert.equal(target.issueNotes.length, 1);
  assert.equal(target.issueNotes[0]!.number, 7);
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
});

test('a user whose resumed issue has a pull request in its state gets the hand-over as a comment on the issue', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: SAVED,
    config: { maxReviewRounds: 1 },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.deepEqual(
    target.issueNotes.map((note) => note.number),
    [7],
  );
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
});

test('a user whose issue is handed over after the review gets the verdict and the reason on the issue', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  await target.run();
  assert.deepEqual(
    target.issueNotes.map((note) => note.number),
    [7, 7],
  );
  assert.match(target.issueNotes[0]!.body, /Review: approved/);
  assert.match(target.issueNotes[1]!.body, /needs help: /);
});

test('a fixer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.equal(target.reverts.length, 1);
});
