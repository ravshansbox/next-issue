import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder } from '../src/observe.mts';
import { logRecords } from './log-records.mts';
import { tempDir } from './temp-dir.mts';

async function recorder(): Promise<Recorder> {
  return Recorder.create(await tempDir(), 'quiet');
}

test('every event goes to the log file with the run id', async () => {
  const target = await recorder();
  target.event('run.start', { repo: 'acme/tool' }, 'verbose');
  target.event('issues', { open: 2 }, 'verbose');
  const records = await logRecords(target);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.kind, 'run.start');
  assert.equal(records[0]!.repo, 'acme/tool');
  assert.equal(records[0]!.runId, target.runId);
  assert.equal(typeof records[0]!.ts, 'string');
});

test('a scope adds its fields to every event under it', async () => {
  const target = await recorder();
  const issue = target.scope({ issue: 7 });
  const role = issue.scope({ role: 'fixer' });
  role.event('agent.start', {}, 'verbose');
  target.event('run.end', {}, 'verbose');
  const records = await logRecords(target);
  assert.equal(records[0]!.issue, 7);
  assert.equal(records[0]!.role, 'fixer');
  assert.equal(records[1]!.issue, undefined);
});

test('a step writes a start and an end with the time', async () => {
  const target = await recorder();
  const result = await target.step('checks', { pr: 3 }, async () => 'pass');
  assert.equal(result, 'pass');
  const records = await logRecords(target);
  assert.deepEqual(
    records.map((record) => record.kind),
    ['checks.start', 'checks.end'],
  );
  assert.equal(records[1]!.pr, 3);
  assert.equal(typeof records[1]!.ms, 'number');
});

test('a step that throws writes an error event and passes the throw on', async () => {
  const target = await recorder();
  await assert.rejects(
    target.step('push', {}, async () => {
      throw new Error('no remote');
    }),
    /no remote/,
  );
  const records = await logRecords(target);
  assert.equal(records[1]!.kind, 'push.error');
  assert.equal(records[1]!.error, 'no remote');
});

test('the summary counts the events and adds the tokens per role', async () => {
  const target = await recorder();
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 };
  target.usage('implementer', usage, 100);
  target.usage('implementer', usage, 50);
  target.usage('reviewer', usage, 20);
  target.event('commit', {}, 'verbose');
  const summary = target.summary();
  assert.equal(summary.runId, target.runId);
  assert.equal(summary.roles.implementer!.calls, 2);
  assert.equal(summary.roles.implementer!.total, 36);
  assert.equal(summary.roles.implementer!.ms, 150);
  assert.equal(summary.total.total, 54);
  assert.equal(summary.counts.usage, 3);
  assert.equal(summary.counts.commit, 1);
  await target.close();
});

test('a summary since an earlier one holds only the tokens and events after it', async () => {
  const target = await recorder();
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 };
  target.usage('implementer', usage, 100);
  target.event('commit', {}, 'verbose');
  const earlier = target.summary();
  target.usage('implementer', usage, 50);
  target.usage('reviewer', usage, 20);
  const summary = target.summary(earlier);
  assert.equal(summary.roles.implementer!.calls, 1);
  assert.equal(summary.roles.implementer!.total, 18);
  assert.equal(summary.roles.implementer!.ms, 50);
  assert.equal(summary.roles.reviewer!.calls, 1);
  assert.equal(summary.total.total, 36);
  assert.deepEqual(summary.counts, { usage: 2 });
  await target.close();
});
