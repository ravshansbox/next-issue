import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Issue } from '../src/shared/github.mts';
import { pendingIssues } from '../src/worker/pending.mts';
import { processIssue } from '../src/worker/pipeline.mts';
import { applyEvent, startProgress } from '../src/worker/progress.mts';
import { type IssueState, stateDir, writeState } from '../src/shared/state.mts';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

const OLDER: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
const LATER: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
const LANDED: IssueState = { ...SAVED, landed: ['abc123'] };

test('a user with one open issue and two closed issues to resume sees an open count of one', async (t) => {
  const closed: Issue = { ...ISSUE, number: 8, createdAt: '2026-01-15T00:00:00Z' };
  const target = await harness(t, {
    saved: LANDED,
    open: [OLDER],
    closed: [ISSUE, closed],
  });
  await writeState(target.context.repo, { ...LANDED, issue: 8 });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => [entry.number, entry.closed === true]),
    [
      [3, false],
      [7, true],
      [8, true],
    ],
  );
  const counts = target.events.filter((record) => record.kind === 'issues');
  assert.deepEqual(
    counts.map((record) => record.open),
    [1],
  );
  assert.equal(target.events.reduce(applyEvent, startProgress()).open, 1);
});

test('a user whose open issues arrive out of order gets them oldest first', async (t) => {
  const target = await harness(t, { open: [LATER, OLDER] });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 9],
  );
});

test('a user whose closed issue has a saved state with a landed change gets the run to drop that state with no revert', async (t) => {
  const target = await harness(t, {
    saved: LANDED,
    open: [],
    closed: [ISSUE],
  });
  const issues = await pendingIssues(target.context);
  const report = await processIssue(target.context, issues[0]!);
  assert.equal(report.outcome, 'skipped');
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.landed, []);
});

test('a user whose closed issue has a corrupt state file gets it back in the list with an error that names the file', async (t) => {
  const target = await harness(t, { open: [], closed: [ISSUE] });
  const folder = stateDir(target.context.repo.root);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{ "issue": 7');
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
  const report = await processIssue(target.context, issues[0]!);
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json is not valid JSON/);
  assert.deepEqual(roles(target), []);
});

test('a user whose open issue has a saved state but lost its status label gets it back in the list', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    open: [],
    unlisted: [{ ...ISSUE, labels: [] }],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
});

test('a user whose saved issue can no longer be read gets the other issues and a logged error for that issue', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    open: [LATER],
    fail: 'viewIssue',
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [9],
  );
  const unreadable = target.events.filter((record) => record.kind === 'issue.unreadable');
  assert.deepEqual(
    unreadable.map((record) => record.issue),
    [7],
  );
});

test('a watcher whose run cannot read a saved issue sees no handled issue for it', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    open: [LATER],
    fail: 'viewIssue',
  });
  await pendingIssues(target.context);
  assert.deepEqual(target.events.reduce(applyEvent, startProgress()).handled, []);
});

test('a user with a ready label gets the unblocked and the blocked ready, in-progress and in-review issues asked for apart from the waiting ones, and the given-up ones left out', async (t) => {
  const target = await harness(t);
  const asked: unknown[] = [];
  target.context.ports.openIssues = async (
    _repo,
    _limit,
    labels,
    without = [],
    _every,
    blocked,
  ) => {
    asked.push([labels, without, blocked]);
    return [];
  };
  await pendingIssues(target.context);
  const listed = ['status:todo', 'status:in-progress', 'status:in-review'];
  const given = ['status:needs-human', 'status:blocked'];
  assert.deepEqual(asked, [
    [listed, given, false],
    [listed, given, true],
    [['status:needs-human'], ['status:blocked'], undefined],
  ]);
});

test('a user with no ready label gets every unblocked and blocked open issue asked for', async (t) => {
  const target = await harness(t);
  target.context.config.labels.ready = '';
  const asked: unknown[] = [];
  target.context.ports.openIssues = async (_repo, _limit, labels, _without, _every, blocked) => {
    asked.push([labels, blocked]);
    return [];
  };
  await pendingIssues(target.context);
  assert.deepEqual(asked, [
    [[], false],
    [[], true],
  ]);
});
