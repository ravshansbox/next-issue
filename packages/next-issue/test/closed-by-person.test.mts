import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Issue } from '../src/github.mts';
import type { IssueReport } from '../src/job.mts';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { applyEvent, startProgress } from '../src/progress.mts';
import type { IssueState } from '../src/state.mts';
import { type Harness, harness, ISSUE, roles } from './harness.mts';

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
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.events.reduce(applyEvent, startProgress()).handled, []);
}

test('a user who closes an issue that was handed over gets the next run to remove its state, branches and worktree with no label, comment or close', async (t) => {
  const first = await harness(t, { commits: [false] });
  assert.equal((await first.run()).outcome, 'needs-human');
  const saved = await first.state();
  assert.equal(saved?.handedOver, true);
  const { target, reports, views } = await closedRun(t, saved);
  assertCleanedUp(target, reports);
  assert.equal(await target.state(), undefined);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, '7'), undefined);
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
  assert.notEqual(await target.context.ports.findWorktree(target.context.repo, '7'), undefined);
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
  assert.equal(await target.context.ports.findWorktree(target.context.repo, '7'), undefined);
});
