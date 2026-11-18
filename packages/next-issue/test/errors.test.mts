import assert from 'node:assert/strict';
import { test } from 'node:test';
import { message, parseJson } from '../src/shared/errors.mts';

test('parseJson reads valid JSON and throws the given failure for invalid JSON', () => {
  assert.deepEqual(
    parseJson('{"a":1}', () => 'unused'),
    { a: 1 },
  );
  assert.throws(
    () => parseJson('{ oops', (error) => `bad file: ${message(error)}`),
    /^Error: bad file: /,
  );
});
