import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Issue } from '../src/github.mts';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { applyEvent, startProgress } from '../src/progress.mts';
import { STATE_DIR, writeState } from '../src/state.mts';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

test('a user who resumes after a merge that closed the issue gets the closed issue back in the list', async (t) => {
  const older: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
  const later: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: true,
    open: [older, later],
    closed: [ISSUE],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 7, 9],
  );
});

test('a user with one open issue and two closed issues to resume sees an open count of one', async (t) => {
  const older: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
  const closed: Issue = { ...ISSUE, number: 8, createdAt: '2026-01-15T00:00:00Z' };
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: true,
    open: [older],
    closed: [ISSUE, closed],
  });
  await writeState(target.context.repo, { ...SAVED, issue: 8 });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 7, 8],
  );
  const counts = target.events.filter((record) => record.kind === 'issues');
  assert.deepEqual(
    counts.map((record) => record.open),
    [1],
  );
  assert.equal(target.events.reduce(applyEvent, startProgress()).open, 1);
});

test('a user whose open issues arrive out of order gets them oldest first', async (t) => {
  const older: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
  const later: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, { open: [later, older] });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 9],
  );
});

test('a user whose closed issue has a saved state but no merged pull request does not get it back in the list', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: false,
    open: [],
    closed: [ISSUE],
  });
  assert.deepEqual(await pendingIssues(target.context), []);
});

test('a user whose closed issue has a corrupt state file gets it back in the list with an error that names the file', async (t) => {
  const target = await harness(t, { open: [], closed: [ISSUE] });
  const folder = join(target.context.repo.root, STATE_DIR);
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
    alreadyMerged: false,
    open: [],
    unlisted: [{ ...ISSUE, labels: [] }],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
});

test('a user whose saved issue can no longer be read gets the other issues and an error for that issue', async (t) => {
  const other: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, {
    saved: SAVED,
    open: [other],
    fail: 'viewIssue',
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [9],
  );
  assert.equal(target.context.recorder.summary().counts['issue.error'], 1);
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
