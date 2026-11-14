import assert from 'node:assert/strict';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneRuns } from '../src/prune-runs.mts';
import { runsDir } from '../src/state.mts';
import { tempDir } from './temp-dir.mts';

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

test('pruneRuns drops a run that is older than the limit', async () => {
  const root = await withRuns({ 'old.jsonl': 8, 'old.summary.json': 8, 'new.jsonl': 6 });
  assert.equal(await pruneRuns(root, 7), 2);
  assert.deepEqual((await readdir(runsDir(root))).sort(), ['new.jsonl']);
});

test('pruneRuns drops the session folder of a run that is older than the limit', async () => {
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

test('pruneRuns keeps the session folder of a run whose sessions are newer than the limit', async () => {
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

test('pruneRuns with a limit of zero keeps every run', async () => {
  const root = await withRuns({ 'old.jsonl': 400 });
  assert.equal(await pruneRuns(root, 0), 0);
  assert.deepEqual(await readdir(runsDir(root)), ['old.jsonl']);
});

test('pruneRuns says nothing about a run directory that is not there', async () => {
  assert.equal(await pruneRuns(await tempDir(), 7), 0);
});
