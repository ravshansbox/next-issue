import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import { lockHolder, processStart } from '../src/shared/lock.mts';
import { tempDir } from './temp-dir.mts';

function liveProcess(t: TestContext): number {
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  return other.pid!;
}

async function deadProcess(): Promise<number> {
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  return dead.pid!;
}

async function lockFile(text: string): Promise<string> {
  const lockPath = join(await tempDir(), 'worker.lock');
  await writeFile(lockPath, text);
  return lockPath;
}

async function withFailingPs(t: TestContext): Promise<void> {
  const bin = await tempDir();
  await writeFile(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
}

test(
  'a client that reads a lock with the local start time written by an older worker in another time zone sees that worker hold it',
  { skip: process.platform === 'linux' && 'Linux reads the start time from /proc' },
  async (t) => {
    const pid = liveProcess(t);
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    t.after(() => {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    });
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    assert.equal(await lockHolder(await lockFile(`${pid} ${stdout.trim()}\n`)), pid);
  },
);

test('a client that cannot read the start time of a live lock holder sees that process hold the lock', async (t) => {
  const pid = liveProcess(t);
  const started = await processStart(pid);
  await withFailingPs(t);
  assert.equal(await lockHolder(await lockFile(`${pid} ${started}\n`)), pid);
});

test('a client that cannot read the start time of a lock holder that is gone sees no holder', async (t) => {
  const pid = await deadProcess();
  await withFailingPs(t);
  assert.equal(await lockHolder(await lockFile(`${pid} Thu Jan  1 00:00:00 1970\n`)), undefined);
});

test('a client that reads a lock whose process id now belongs to another process sees no holder', async (t) => {
  const pid = liveProcess(t);
  assert.equal(await lockHolder(await lockFile(`${pid} Thu Jan  1 00:00:00 1970\n`)), undefined);
});
