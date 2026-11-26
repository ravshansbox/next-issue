import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Issue } from '../src/shared/github.mts';
import type { IssueReport } from '../src/shared/job.mts';
import { pendingIssues } from '../src/worker/pending.mts';
import { processIssue } from '../src/worker/pipeline.mts';
import { type IssueState, newState } from '../src/shared/state.mts';
import { APPROVE, type Harness, harness, ISSUE, roles } from './harness.mts';

async function closedRun(
  t: Parameters<typeof harness>[0],
  saved: IssueState | undefined,
): Promise<{ target: Harness; reports: IssueReport[]; views: () => number }> {
  const closedIssue: Issue = { ...ISSUE, labels: ['status:needs-human'] };
  const target = await harness(t, {
    saved,
    open: [],
    closed: [closedIssue],
    disputes: ['7-dispute-1'],
  });
  let views = 0;
  const view = target.context.ports.viewIssue;
  target.context.ports.viewIssue = async (repo, number) => {
    views += 1;
    return view(repo, number);
  };
  const reports: IssueReport[] = [];
  for (const issue of await pendingIssues(target.context)) {
    reports.push(await processIssue(target.context, issue));
  }
  return { target, reports, views: () => views };
}

function assertCleanedUp(target: Harness, reports: IssueReport[]): void {
  assert.ok(reports.every((report) => report.outcome === 'skipped'));
  assert.deepEqual(target.deleted, ['7', '7-dispute-1']);
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(target.comments, []);
  assert.deepEqual(target.closed, []);
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.reverts, []);
  assert.ok(
    !target.events.some((record) => record.kind === 'issue.end' || record.kind === 'issue.error'),
  );
}

test('a user who closes an issue that was handed over gets the next run to remove its state, branches and worktree with no label, comment or close', async (t) => {
  const first = await harness(t, { commits: [false] });
  assert.equal((await first.run()).outcome, 'needs-human');
  const saved = await first.state();
  assert.equal(saved?.handedOver, true);
  const { target, reports, views } = await closedRun(t, saved);
  assertCleanedUp(target, reports);
  assert.equal(await target.state(), undefined);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, 7, '7'), undefined);
  const before = views();
  await pendingIssues(target.context);
  assert.equal(views(), before);
});

test('a user who closes an issue whose hand-over came while it was closing gets the next run to remove its state and branches with no label, comment or close', async (t) => {
  const first = await harness(t, { commits: [false] });
  await first.run();
  const saved = await first.state();
  assert.notEqual(saved, undefined);
  const { target, reports } = await closedRun(t, { ...saved!, closing: true, handedOver: true });
  assertCleanedUp(target, reports);
  assert.equal(await target.state(), undefined);
});

test('a user who closes an issue whose worktree and branches cannot be removed gets them kept and logged while the run removes its state', async (t) => {
  const first = await harness(t, { pressDuring: 'implementer' });
  await first.run();
  const saved = await first.state();
  const target = await harness(t, {
    saved,
    open: [],
    closed: [ISSUE],
    disputes: ['7-dispute-1'],
  });
  target.context.ports.removeWorktree = async () => false;
  target.context.ports.deleteBranch = async () => false;
  const reports: IssueReport[] = [];
  for (const issue of await pendingIssues(target.context)) {
    reports.push(await processIssue(target.context, issue));
  }
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['skipped'],
  );
  assert.equal(await target.state(), undefined);
  assert.notEqual(await target.context.ports.findWorktree(target.context.repo, 7, '7'), undefined);
  assert.deepEqual(
    target.events.filter((record) => record.kind === 'branch.kept').map((record) => record.branch),
    ['7', '7-dispute-1'],
  );
  assert.equal(target.events.filter((record) => record.kind === 'worktree.kept').length, 1);
});

test('a user who closes an issue that a stop after the round left with its worktree gets the next run to remove its state, branches and worktree with no label, comment or close', async (t) => {
  const first = await harness(t, { pressDuring: 'implementer' });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  assert.notEqual(saved, undefined);
  const { target, reports } = await closedRun(t, saved);
  assertCleanedUp(target, reports);
  assert.equal(await target.state(), undefined);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, 7, '7'), undefined);
});

test('a user who closes an issue just after a run lists it as open gets the run to skip it as closed with no label, comment or agent', async (t) => {
  const target = await harness(t, { closed: [ISSUE] });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.equal(report.reason, 'closed');
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(target.comments, []);
  assert.deepEqual(target.closed, []);
});

test('a user who closes a stopped issue just after a run lists it as open gets the run to remove its state, branches and worktree with no label, comment or agent', async (t) => {
  const first = await harness(t, { pressDuring: 'implementer' });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const target = await harness(t, { saved, closed: [ISSUE], disputes: ['7-dispute-1'] });
  const report = await target.run();
  assertCleanedUp(target, [report]);
  assert.equal(report.reason, 'closed');
  assert.equal(await target.state(), undefined);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, 7, '7'), undefined);
});

test('a person who closes an issue halted on a checks error gets the next run to log land.released with the reason closed and land another issue', async (t) => {
  const first = await harness(t, { verdicts: [APPROVE, APPROVE] });
  first.context.ports.waitForCiChecks = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  assert.equal((await first.run()).reason, 'checks error');
  const { target } = await closedRun(t, await first.state());
  assert.ok(
    target.events.some(
      (record) =>
        record['kind'] === 'land.released' &&
        record['issue'] === 7 &&
        record['reason'] === 'closed',
    ),
  );
  const other = await harness(t, {
    root: target.context.repo.root,
    issue: { ...ISSUE, number: 8 },
  });
  assert.equal((await other.run()).outcome, 'done');
  assert.equal(other.landed.length, 1);
});

test('a person who closes an issue that is not halted gets the next run to log no land.released', async (t) => {
  const first = await harness(t, { commits: [false] });
  await first.run();
  const { target } = await closedRun(t, await first.state());
  assert.ok(!target.events.some((record) => record['kind'] === 'land.released'));
});

test('a person who closes a halted issue with nothing on the base gets the next run to log no land.released', async (t) => {
  const { target } = await closedRun(t, { ...newState(7, '7'), halted: true });
  assert.ok(!target.events.some((record) => record['kind'] === 'land.released'));
});
