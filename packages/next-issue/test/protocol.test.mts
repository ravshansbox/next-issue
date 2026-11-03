import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer } from '../src/protocol.mts';

test('a version is newer only when a part of it is greater', () => {
  assert.equal(isNewer('2.0.1', '2.0.0'), true);
  assert.equal(isNewer('2.10.0', '2.9.0'), true);
  assert.equal(isNewer('2.0.0', '2.0.0'), false);
  assert.equal(isNewer('1.9.9', '2.0.0'), false);
});
