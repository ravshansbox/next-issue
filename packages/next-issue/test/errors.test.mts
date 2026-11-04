import assert from 'node:assert/strict';
import { test } from 'node:test';
import { message } from '../src/errors.mts';

test('message reads an error and anything else', () => {
  assert.equal(message(new Error('bad')), 'bad');
  assert.equal(message('plain'), 'plain');
  assert.equal(message(undefined), 'undefined');
});
