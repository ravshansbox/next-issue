import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSocketPath } from '../src/worker-paths.mts';

test('a worker whose socket path is too long for the system says so', () => {
  assert.throws(
    () => checkSocketPath(`/${'a'.repeat(103)}`, 'darwin'),
    /the socket path \/a+ is too long for this system: 104 bytes, at most 103/,
  );
  assert.doesNotThrow(() => checkSocketPath(`/${'a'.repeat(102)}`, 'darwin'));
  assert.doesNotThrow(() => checkSocketPath(`/${'a'.repeat(106)}`, 'linux'));
});
