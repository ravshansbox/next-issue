import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerArgs } from '../src/worker.ts';

test('the extension starts the worker release that matches its own version', () => {
  assert.deepEqual(workerArgs('1.2.3'), ['-y', 'next-issue@1.2.3', 'serve']);
});
