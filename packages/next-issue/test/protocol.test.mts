import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer } from '../src/protocol.mts';

test('a version is newer only when a part of it is greater', () => {
  assert.equal(isNewer('2.0.1', '2.0.0'), true);
  assert.equal(isNewer('2.10.0', '2.9.0'), true);
  assert.equal(isNewer('2.0.0', '2.0.0'), false);
  assert.equal(isNewer('1.9.9', '2.0.0'), false);
});

test('a release is newer than its pre-releases, and later pre-releases are newer', () => {
  assert.equal(isNewer('2.5.1', '2.5.1-beta.1'), true);
  assert.equal(isNewer('2.5.1-beta.1', '2.5.1'), false);
  assert.equal(isNewer('2.5.0-beta.2', '2.5.0-beta.1'), true);
  assert.equal(isNewer('2.5.0-beta.10', '2.5.0-beta.9'), true);
  assert.equal(isNewer('2.5.0-beta', '2.5.0-alpha.3'), true);
  assert.equal(isNewer('2.5.0-beta.1', '2.5.0-beta'), true);
  assert.equal(isNewer('2.5.0-beta.1', '2.5.0-beta.1'), false);
  assert.equal(isNewer('2.5.0-beta.1', '2.4.9'), true);
});
