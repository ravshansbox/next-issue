import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/pipeline.mts';
import { APPROVE, harness, ISSUE, SAVED } from './harness.mts';

const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };

test('a user whose change lands and whose first read of its checks on main fails gets the issue handed over with the error, the landed commit kept and the run halted', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  target.context.ports.waitForBaseChecks = async () => {
    throw new Error('gh: HTTP 401: Bad credentials');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'checks error');
  assert.equal(report.halt, true);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual((await target.state())?.landed, ['2']);
  assert.match(
    target.comments.at(-1) ?? '',
    /The read of the checks on main failed: gh: HTTP 401: Bad credentials\..*landed commit is on `main`.*checks were not awaited/s,
  );
  const other = await processIssue(target.context, { ...ISSUE, number: 8 });
  assert.equal(other.outcome, 'stopped');
  assert.equal(other.reason, 'run halted');
  assert.deepEqual(target.landed, ['2']);
});

test('a user who resumes an issue with a push to main saved and whose fetch of main fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, pushing: '9' },
    baseFetchFails: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.reason, 'fetch failed');
  assert.equal(report.halt, true);
  assert.equal(target.context.halted, true);
  assert.equal((await target.state())?.pushing, '9');
  assert.match(
    target.comments.at(-1) ?? '',
    /fetch failed.*a push may be on `main`.*checks were not awaited/s,
  );
});

test('a user who resumes an issue with a change landed on main and whose worktree fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, landed: ['0'] } });
  target.context.ports.addWorktree = async () => {
    throw new Error('git worktree add: disk full');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, true);
  assert.deepEqual((await target.state())?.landed, ['0']);
  assert.match(
    target.comments.at(-1) ?? '',
    /disk full.*landed commit is on `main`.*checks were not awaited/s,
  );
});

test('a user whose new issue fails with an error before anything lands gets the issue ended in error and the run kept going', async (t) => {
  const target = await harness(t);
  target.context.ports.addWorktree = async () => {
    throw new Error('git worktree add: disk full');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, undefined);
  assert.equal(target.context.halted, false);
});

test('a user who resumes an issue with a change landed on main and whose check for an unlanded fix fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, landed: ['0'] } });
  target.context.ports.revision = async () => '1';
  target.context.ports.isLanded = async () => {
    throw new Error('git merge-base: bad object');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, true);
  assert.deepEqual((await target.state())?.landed, ['0']);
  assert.match(
    target.comments.at(-1) ?? '',
    /bad object.*landed commit is on `main`.*checks were not awaited/s,
  );
});
