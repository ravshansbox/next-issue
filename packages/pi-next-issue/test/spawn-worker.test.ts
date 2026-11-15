import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnLogged, workerArgs, workerPaths } from '../src/spawn-worker.ts';
import { tempFolder } from './temp-folder.ts';

test('the extension starts the worker release that matches its own version', () => {
  assert.deepEqual(workerArgs('1.2.3'), ['-y', 'next-issue@1.2.3', 'serve']);
});

test('the extension run from a source checkout starts the latest worker release', () => {
  assert.deepEqual(workerArgs('0.0.0'), ['-y', 'next-issue@latest', 'serve']);
});

test('the extension keeps the worker socket and log of a repository in its .next-issue folder', () => {
  assert.deepEqual(workerPaths('/repo'), {
    socketPath: '/repo/.next-issue/worker.sock',
    logPath: '/repo/.next-issue/worker.log',
    lockPath: '/repo/.next-issue/worker.lock',
  });
});

test('the extension names the exit of a spawned worker and points to the worker log, not to a line that another process wrote there', async () => {
  const root = tempFolder();
  mkdirSync(join(root, '.next-issue'));
  const log = join(root, '.next-issue', 'worker.log');
  writeFileSync(log, 'an older run\n');
  const reason = await new Promise<string>((resolve) =>
    spawnLogged(
      root,
      process.execPath,
      [
        '-e',
        `console.error('next-issue: another worker is running'); require('node:fs').appendFileSync(${JSON.stringify(log)}, 'next-issue: worker listening\\n'); process.exit(1)`,
      ],
      resolve,
    ),
  );
  assert.equal(reason, 'exit code 1 (see .next-issue/worker.log)');
});
