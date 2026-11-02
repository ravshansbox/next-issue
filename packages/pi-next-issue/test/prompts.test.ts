import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommitSubject, parseUnrelated } from '../src/prompts.ts';

test('the runner takes the commit subject from the last commit line of the reply', () => {
  assert.equal(
    parseCommitSubject('commit: feat: first\nmore work\ncommit: fix: second', 'feat: fallback'),
    'fix: second',
  );
});

test('the runner strips backticks and spaces around the commit subject', () => {
  assert.equal(parseCommitSubject('done\nCommit:   `fix: trim it`  ', 'x'), 'fix: trim it');
});

test('the runner uses the fallback subject when the reply has no commit line', () => {
  assert.equal(parseCommitSubject('done without a subject', 'feat: fallback'), 'feat: fallback');
});

test('the runner uses the fallback subject when the commit line is empty', () => {
  assert.equal(parseCommitSubject('commit: ``', 'feat: fallback'), 'feat: fallback');
});

test('the runner ignores a commit word that does not start a line', () => {
  assert.equal(parseCommitSubject('please commit: nothing', 'feat: fallback'), 'feat: fallback');
});

test('the runner reads why the fixer calls a problem unrelated', () => {
  assert.equal(
    parseUnrelated('looked around\nunrelated: the flaky test fails on main too'),
    'the flaky test fails on main too',
  );
});

test('the runner treats a reply without an unrelated line as a fix', () => {
  assert.equal(parseUnrelated('fixed it\ncommit: fix: it'), undefined);
});
