import assert from 'node:assert/strict';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import { pruneRuns } from '../src/worker/prune-runs.mts';
import { runRepo } from '../src/worker/run.mts';
import { runsDir } from '../src/shared/state.mts';
import { idleGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';
import { writeScripts, serveBase } from './helpers.mts';

const DAY = 24 * 60 * 60_000;

async function withRuns(ages: Record<string, number>): Promise<string> {
  const root = await tempDir();
  const dir = runsDir(root);
  await mkdir(dir, { recursive: true });
  for (const [name, days] of Object.entries(ages)) {
    const path = join(dir, name);
    await writeFile(path, '{}\n');
    const when = new Date(Date.now() - days * DAY);
    await utimes(path, when, when);
  }
  return root;
}

test('the worker drops a run log that is older than the limit', async () => {
  const root = await withRuns({ 'old.jsonl': 8, 'old.summary.json': 8, 'new.jsonl': 6 });
  assert.equal(await pruneRuns(root, 7), 2);
  assert.deepEqual((await readdir(runsDir(root))).sort(), ['new.jsonl']);
});

test('the worker drops the session folder of a run that is older than the limit', async () => {
  const root = await withRuns({ 'new.jsonl': 6 });
  const dir = runsDir(root);
  await mkdir(join(dir, 'old', 'sessions'), { recursive: true });
  await writeFile(join(dir, 'old', 'sessions', 'a.jsonl'), '{}\n');
  const when = new Date(Date.now() - 8 * DAY);
  await utimes(join(dir, 'old', 'sessions', 'a.jsonl'), when, when);
  await utimes(join(dir, 'old', 'sessions'), when, when);
  await utimes(join(dir, 'old'), when, when);
  assert.equal(await pruneRuns(root, 7), 1);
  assert.deepEqual(await readdir(dir), ['new.jsonl']);
});

test('the worker keeps the session folder of a run whose sessions are newer than the limit', async () => {
  const root = await withRuns({});
  const dir = runsDir(root);
  await mkdir(join(dir, 'long', 'sessions'), { recursive: true });
  await writeFile(join(dir, 'long', 'sessions', 'a.jsonl'), '{}\n');
  const when = new Date(Date.now() - 10 * DAY);
  await utimes(join(dir, 'long', 'sessions'), when, when);
  await utimes(join(dir, 'long'), when, when);
  assert.equal(await pruneRuns(root, 7), 0);
  assert.deepEqual(await readdir(join(dir, 'long', 'sessions')), ['a.jsonl']);
});

test('the worker keeps every run when the limit is zero', async () => {
  const root = await withRuns({ 'old.jsonl': 400 });
  assert.equal(await pruneRuns(root, 0), 0);
  assert.deepEqual(await readdir(runsDir(root)), ['old.jsonl']);
});

test('the worker says nothing about a run directory that is not there', async () => {
  assert.equal(await pruneRuns(await tempDir(), 7), 0);
});

test('a user whose event listener fails on the pruned runs event is left with no open run log', async (t) => {
  const root = await withRuns({ 'old.jsonl': 30 });
  await must('git', ['init', '-q'], { cwd: root });
  await writeScripts(root, ['format', 'lint', 'typecheck', 'test']);
  await must('git', ['remote', 'add', 'origin', 'git@github.com:acme/prune.git'], {
    cwd: root,
  });
  await serveBase(root);
  await idleGh(t);
  const openBefore = (await readdir('/dev/fd')).length;
  await assert.rejects(
    runRepo(root, parseArgs(['start', '--watch', 'off']), {
      interrupts: { afterIssue: () => false, afterRound: () => false, sleep: async () => false },
      onEvent: (record) => {
        if (record.kind === 'runs.pruned') {
          throw new Error('listener failed');
        }
      },
    }),
    /listener failed/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await readdir('/dev/fd')).length, openBefore);
});
