import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addUsage, emptyUsage } from '../src/usage.mts';

test('addUsage adds every field', () => {
  const target = emptyUsage();
  addUsage(target, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
  addUsage(target, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
  assert.deepEqual(target, { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
});
