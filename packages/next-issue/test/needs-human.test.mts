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
  assert.equal(report.pr, undefined);
  assert.equal(target.pushes, 0);
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
