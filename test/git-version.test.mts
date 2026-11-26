import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitVersionError } from '../src/worker/git-version.mts';

test('the worker accepts git 2.40 and later, including vendor suffixes', () => {
  for (const output of [
    'git version 2.40.0',
    'git version 2.53.0',
    'git version 2.45.0.windows.1',
    'git version 2.41.0 (Apple Git-154)',
    'git version 3.0.0',
  ]) {
    assert.equal(gitVersionError(output), undefined, output);
  }
});

test('the worker refuses git older than 2.40 with an error that names both versions', () => {
  assert.equal(
    gitVersionError('git version 2.34.1'),
    'git 2.34.1 is too old: next-issue needs git 2.40 or later',
  );
  assert.equal(
    gitVersionError('git version 2.39.3 (Apple Git-146)'),
    'git 2.39.3 is too old: next-issue needs git 2.40 or later',
  );
});

test('the worker refuses a git --version output it cannot read', () => {
  assert.match(gitVersionError('hello') ?? '', /cannot read the git version from "hello"/);
});
