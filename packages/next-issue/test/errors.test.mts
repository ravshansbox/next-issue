import assert from 'node:assert/strict';
import { test } from 'node:test';
import { message, parseJson } from '../src/errors.mts';

test('message reads an error and anything else', () => {
  assert.equal(message(new Error('bad')), 'bad');
  assert.equal(message('plain'), 'plain');
  assert.equal(message(undefined), 'undefined');
});

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
