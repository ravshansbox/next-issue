import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueReport } from '../src/shared/job.mts';
import { pendingIssues } from '../src/worker/pending.mts';
import { processIssue } from '../src/worker/pipeline.mts';
import { APPROVE, changes, harness, ISSUE } from './harness.mts';

test('the worker pushes the issue branch after the implementer commit and after the squash, then deletes the remote branch once the issue lands', async (t) => {
  const target = await harness(t);
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.pushed, [
    { branch: '7', head: '1' },
    { branch: '7', head: '2' },
  ]);
  assert.deepEqual(target.remoteDeleted, ['7']);
});

test('the worker pushes the issue branch after the commit of a review fixer', async (t) => {
  const target = await harness(t, { verdicts: [changes('The count is wrong.'), APPROVE] });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(
    target.pushed.map((push) => push.head),
    ['1', '2', '3'],
  );
});

test('the worker pushes the issue branch after it commits the merge of the base', async (t) => {
  const target = await harness(t, { merges: [[]] });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(
    target.pushed.map((push) => push.head),
    ['1', '2', '3'],
  );
});

test('a worker whose branch push fails logs the failure and still lands the issue', async (t) => {
  const target = await harness(t, { branchPushFails: 'remote: permission denied' });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.landed, ['2']);
  const failures = target.events.filter((record) => record.kind === 'branch.push-fail');
  assert.equal(failures.length, 2);
  assert.equal(failures[0]!.branch, '7');
  assert.equal(failures[0]!.error, 'remote: permission denied');
});

test('a worker that hands an issue over keeps its remote branch', async (t) => {
  const target = await harness(t, { verdicts: [changes('Wrong.'), changes('Still wrong.')] });
  target.context.config.maxReviewRounds = 1;
  assert.equal((await target.run()).outcome, 'needs-human');
  assert.deepEqual(target.remoteDeleted, []);
});

test('a worker whose issue fails with an error keeps its remote branch', async (t) => {
  const target = await harness(t, { fail: 'diff' });
  assert.equal((await target.run()).outcome, 'error');
  assert.deepEqual(target.remoteDeleted, []);
});

test('a worker that drops an issue a person closed deletes its remote branch but no dispute branch', async (t) => {
  const first = await harness(t, { commits: [false] });
  assert.equal((await first.run()).outcome, 'needs-human');
  const target = await harness(t, {
    saved: await first.state(),
    open: [],
    closed: [{ ...ISSUE, labels: ['status:needs-human'] }],
    disputes: ['7-dispute-1'],
  });
  const reports: IssueReport[] = [];
  for (const issue of await pendingIssues(target.context)) {
    reports.push(await processIssue(target.context, issue));
  }
  assert.ok(reports.every((report) => report.outcome === 'skipped'));
  assert.deepEqual(target.remoteDeleted, ['7']);
});

test('a fixer that disputes and leaves a change gets no dispute branch pushed', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention'],
  });
  assert.equal((await target.run()).outcome, 'needs-human');
  assert.equal(target.asides.length, 1);
  assert.ok(target.pushed.every((push) => push.branch === '7'));
});
