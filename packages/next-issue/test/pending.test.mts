import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Issue } from '../src/github.mts';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { applyEvent, startProgress } from '../src/progress.mts';
import { type IssueState, stateDir, writeState } from '../src/state.mts';
import { newRun, runControls } from '../src/worker-run.mts';
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
    issues.map((entry) => entry.number),
    [3],
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

test('a user whose closed issue has a saved state with a landed change does not get it back in the list', async (t) => {
  const target = await harness(t, {
    saved: LANDED,
    open: [],
    closed: [ISSUE],
  });
  assert.deepEqual(await pendingIssues(target.context), []);
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

test('a watcher whose run cannot read a saved issue is not sent the question list again', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    open: [LATER],
    fail: 'viewIssue',
  });
  await pendingIssues(target.context);
  let sent = 0;
  const run = newRun(startProgress());
  const controls = runControls(
    run,
    (next) => {
      run.progress = next;
    },
    () => {
      sent += 1;
    },
  );
  target.events.forEach((record) => controls.onEvent?.(record));
  assert.equal(sent, 0);
});

test('a user with a ready label gets only the ready, in-progress and in-review issues asked for', async (t) => {
  const target = await harness(t);
  const asked: string[][] = [];
  target.context.ports.openIssues = async (_repo, _limit, labels) => {
    asked.push(labels);
    return [];
  };
  await pendingIssues(target.context);
  assert.deepEqual(asked, [['status:todo', 'status:in-progress', 'status:in-review']]);
});

test('a user with no ready label gets every open issue asked for', async (t) => {
  const target = await harness(t);
  target.context.config.labels.ready = '';
  const asked: string[][] = [];
  target.context.ports.openIssues = async (_repo, _limit, labels) => {
    asked.push(labels);
    return [];
  };
  await pendingIssues(target.context);
  assert.deepEqual(asked, [[]]);
});
