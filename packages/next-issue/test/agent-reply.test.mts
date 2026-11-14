import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommitSubject, parseResolved, parseUnrelated } from '../src/agent-reply.mts';

const FALLBACK = 'fix: fallback';

test('parseCommitSubject reads the last line of the agent text', () => {
  assert.equal(parseCommitSubject('Done.\ncommit: feat: add a flag', FALLBACK), 'feat: add a flag');
});

test('parseCommitSubject reads the last commit line when the agent quoted the rule earlier', () => {
  assert.equal(
    parseCommitSubject(
      'I will end with commit: <subject>\ncommit: docs: wrong\nDone.\ncommit: fix: right',
      FALLBACK,
    ),
    'fix: right',
  );
});

test('parseCommitSubject accepts other letter cases and spaces', () => {
  assert.equal(parseCommitSubject('Commit:   fix: trim', FALLBACK), 'fix: trim');
});

test('parseCommitSubject falls back without a line', () => {
  assert.equal(parseCommitSubject('No subject here', FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject('commit:   ', FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject('', FALLBACK), FALLBACK);
});

test('parseCommitSubject drops the backticks an agent wrapped the subject in', () => {
  assert.equal(
    parseCommitSubject('commit: `fix(ucps): re-probe a batch`', FALLBACK),
    'fix(ucps): re-probe a batch',
  );
  assert.equal(parseCommitSubject('commit: ``build: lint``', FALLBACK), 'build: lint');
  assert.equal(parseCommitSubject('commit: ` ci: deploy `', FALLBACK), 'ci: deploy');
});

test('parseCommitSubject keeps a backtick inside the subject', () => {
  assert.equal(
    parseCommitSubject('commit: fix(api): reject a `null` body', FALLBACK),
    'fix(api): reject a `null` body',
  );
});

test('parseCommitSubject falls back when the subject is only backticks', () => {
  assert.equal(parseCommitSubject('commit: ``', FALLBACK), FALLBACK);
});

test('parseUnrelated reads the marker line', () => {
  assert.equal(
    parseUnrelated('looked at it\nunrelated: the spec fails on main too'),
    'the spec fails on main too',
  );
  assert.equal(parseUnrelated('UNRELATED:   spaced  '), 'spaced');
});

test('parseUnrelated reads the last marker line when the agent quoted the rule earlier', () => {
  assert.equal(
    parseUnrelated('unrelated: <one sentence>\nchecked\nunrelated: main fails too'),
    'main fails too',
  );
});

test('parseUnrelated gives undefined without the marker', () => {
  assert.equal(parseUnrelated('commit: fix: the thing'), undefined);
  assert.equal(parseUnrelated('unrelated:   '), undefined);
  assert.equal(parseUnrelated(''), undefined);
});

test('parseResolved reads the last marker line', () => {
  assert.equal(
    parseResolved('resolved: <how>\nran it\nresolved: the test failed before the fix'),
    'the test failed before the fix',
  );
  assert.equal(parseResolved('resolved:   '), undefined);
  assert.equal(parseResolved('unrelated: wrong'), undefined);
});
