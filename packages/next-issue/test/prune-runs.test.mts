import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneRuns } from '../src/prune-runs.mts';
import { STATE_DIR } from '../src/state.mts';

const DAY = 24 * 60 * 60_000;

async function runsDir(ages: Record<string, number>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const dir = join(root, STATE_DIR, 'runs');
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
  const root = await runsDir({ 'old.jsonl': 8, 'old.summary.json': 8, 'new.jsonl': 6 });
  assert.equal(await pruneRuns(root, 7), 2);
  assert.deepEqual((await readdir(join(root, STATE_DIR, 'runs'))).sort(), ['new.jsonl']);
});

test('pruneRuns drops the session folder of a run that is older than the limit', async () => {
  const root = await runsDir({ 'new.jsonl': 6 });
  const dir = join(root, STATE_DIR, 'runs');
  await mkdir(join(dir, 'old', 'sessions'), { recursive: true });
  await writeFile(join(dir, 'old', 'sessions', 'a.jsonl'), '{}\n');
  const when = new Date(Date.now() - 8 * DAY);
  await utimes(join(dir, 'old'), when, when);
  assert.equal(await pruneRuns(root, 7), 1);
  assert.deepEqual(await readdir(dir), ['new.jsonl']);
});

test('pruneRuns with a limit of zero keeps every run', async () => {
  const root = await runsDir({ 'old.jsonl': 400 });
  assert.equal(await pruneRuns(root, 0), 0);
  assert.deepEqual(await readdir(join(root, STATE_DIR, 'runs')), ['old.jsonl']);
});

test('pruneRuns says nothing about a run directory that is not there', async () => {
  assert.equal(await pruneRuns(await mkdtemp(join(tmpdir(), 'next-issue-')), 7), 0);
});
