import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mts';

test('a user whose repository has no checks gets the landed change done', async (t) => {
  const target = await harness(t, { baseChecks: ['none'] });
  assert.equal((await target.run()).outcome, 'done');
});

