import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Recorder } from '../src/shared/observe.mts';
import { fullDisk } from './full-disk.mts';
import { logRecords } from './log-records.mts';
import { tempDir } from './temp-dir.mts';

async function recorder(): Promise<Recorder> {
  return Recorder.create(await tempDir());
}

test('the run writes every event to the log file with the run id', async () => {
  const target = await recorder();
  target.record('run.start', { repo: 'acme/tool' });
  target.record('issues', { open: 2 });
  const records = await logRecords(target);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.kind, 'run.start');
  assert.equal(records[0]!.repo, 'acme/tool');
  assert.equal(records[0]!.runId, target.runId);
  assert.equal(typeof records[0]!.ts, 'string');
});

test('the run adds the fields of a scope to every event under it', async () => {
  const target = await recorder();
  const issue = target.scope({ issue: 7 });
  const role = issue.scope({ role: 'fixer' });
  role.record('agent.start', {});
  target.record('run.end', {});
  const records = await logRecords(target);
  assert.equal(records[0]!.issue, 7);
  assert.equal(records[0]!.role, 'fixer');
  assert.equal(records[1]!.issue, undefined);
});

test('the run writes a start and an end with the time for each step', async () => {
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

test('the run writes an error event for a step that throws and passes the throw on', async () => {
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

test('the run summary counts the events and adds the tokens per role', async () => {
  const target = await recorder();
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 };
  target.usage('implementer', usage, 100);
  target.usage('implementer', usage, 50);
  target.usage('reviewer', usage, 20);
  target.record('commit', {});
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

test('the run summary since an earlier one holds only the tokens and events after it', async () => {
  const target = await recorder();
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 };
  target.usage('implementer', usage, 100);
  target.record('commit', {});
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

function failingLog(t: TestContext): string[] {
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

test('a run whose log write fails keeps passing events to its listener and reports the error once', async (t) => {
  const written = failingLog(t);
  const seen: string[] = [];
  const target = await Recorder.create(
    await tempDir(),
    (record) => seen.push(String(record.kind)),
    fullDisk,
  );
  target.record('run.start', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  target.record('issue.start', {});
  target.record('issue.end', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, ['run.start', 'issue.start', 'issue.end']);
  const reports = written.filter((line) => line.includes('ENOSPC'));
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /^the run log /);
  await target.close();
});

test('a run whose log write fails closes its log without a throw or a hang', async (t) => {
  failingLog(t);
  const target = await Recorder.create(await tempDir(), undefined, fullDisk);
  target.record('run.start', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await target.close();
});

test('a run whose log fails on its last write closes its log without a throw or a hang', async (t) => {
  failingLog(t);
  const target = await Recorder.create(await tempDir(), undefined, fullDisk);
  target.record('run.end', {});
  await target.close();
});

test('a run whose log file cannot be opened keeps running and closes its log', async (t) => {
  const written = failingLog(t);
  const root = await tempDir();
  const target = await Recorder.create(root, undefined, () =>
    createWriteStream(join(root, 'missing', 'run.jsonl'), { flags: 'a' }),
  );
  target.record('run.start', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(written.filter((line) => line.includes('ENOENT')).length, 1);
  await target.close();
});
