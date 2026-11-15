import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockHolder, processStart } from '../src/lock.ts';
import { tempFolder } from './temp-folder.ts';

function lockFile(text: string): string {
  const path = join(tempFolder(), 'worker.lock');
  writeFileSync(path, text);
  return path;
}

test('the extension reads the process id of a live process that holds the worker lock', async () => {
  const started = await processStart(process.pid);
  assert.equal(await lockHolder(lockFile(`${process.pid} ${started}\n`)), process.pid);
});

test('the extension finds no holder when the lock process id now belongs to another process', async () => {
  assert.equal(await lockHolder(lockFile(`${process.pid} not-its-start\n`)), undefined);
});

test('the extension finds no holder when no lock file exists', async () => {
  assert.equal(await lockHolder(join(tempFolder(), 'worker.lock')), undefined);
});
