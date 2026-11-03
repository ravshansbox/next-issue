import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerArgs, workerPaths } from '../src/worker.ts';

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
  });
});
