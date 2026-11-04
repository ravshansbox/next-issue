import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes, harness } from './harness.mts';

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

test('an implementer that changes nothing on a branch already ahead of the base gets a pull request with the title of the earlier commit', async (t) => {
  const target = await harness(t, { commits: [false], earlier: 'fix: earlier work' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.titles, ['fix: earlier work']);
});

test('a user whose issue is handed over before a pull request exists gets the reason as a comment on the issue', async (t) => {
  const target = await harness(t, { commits: [false] });
  await target.run();
  assert.equal(target.issueNotes.length, 1);
  assert.equal(target.issueNotes[0]!.number, 7);
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
  assert.deepEqual(target.comments, []);
});

test('a user whose issue is handed over after the pull request exists gets the reason on the pull request only', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['fail'] });
  await target.run();
  assert.match(target.comments.at(-1)!, /needs help: /);
  assert.deepEqual(target.issueNotes, []);
});

test('a fixer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['fail'], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.equal(target.pushes, 1);
});
