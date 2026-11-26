import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseCommitSubject,
  parseDone,
  parseQuestions,
  parseResolved,
  parseUnrelated,
} from '../src/worker/agent-reply.mts';
import { withoutClosingReferences } from '../src/shared/text.mts';

const FALLBACK = 'fix: fallback';

test('the worker reads the commit subject from the last line of the agent text', () => {
  assert.equal(parseCommitSubject('Done.\ncommit: feat: add a flag', FALLBACK), 'feat: add a flag');
});

test('the worker reads the last commit line as the subject when the agent quoted the rule earlier', () => {
  assert.equal(
    parseCommitSubject(
      'I will end with commit: <subject>\ncommit: docs: wrong\nDone.\ncommit: fix: right',
      FALLBACK,
    ),
    'fix: right',
  );
});

test('the worker reads a commit line in other letter cases and with extra spaces', () => {
  assert.equal(parseCommitSubject('Commit:   fix: trim', FALLBACK), 'fix: trim');
});

test('the worker falls back to the default subject when the agent gives no commit line', () => {
  assert.equal(parseCommitSubject('No subject here', FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject('commit:   ', FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject('', FALLBACK), FALLBACK);
});

test('an agent reply with a bare commit line followed by prose parses to the fallback subject', () => {
  assert.equal(parseCommitSubject('Done.\ncommit:\n\nThe tests pass now.', FALLBACK), FALLBACK);
  assert.equal(
    parseCommitSubject('commit: docs: earlier\nDone.\ncommit:   \r\nThe tests pass now.', FALLBACK),
    FALLBACK,
  );
});

test('the worker drops the backticks an agent wrapped the commit subject in', () => {
  assert.equal(
    parseCommitSubject('commit: `fix(ucps): re-probe a batch`', FALLBACK),
    'fix(ucps): re-probe a batch',
  );
  assert.equal(parseCommitSubject('commit: ``build: lint``', FALLBACK), 'build: lint');
  assert.equal(parseCommitSubject('commit: ` ci: deploy `', FALLBACK), 'ci: deploy');
});

test('the worker keeps a backtick inside the commit subject', () => {
  assert.equal(
    parseCommitSubject('commit: fix(api): reject a `null` body', FALLBACK),
    'fix(api): reject a `null` body',
  );
});

test('the worker falls back to the default subject when the commit subject is only backticks', () => {
  assert.equal(parseCommitSubject('commit: ``', FALLBACK), FALLBACK);
});

test('the worker reads the unrelated failure from the marker line of the fixer', () => {
  assert.equal(
    parseUnrelated('looked at it\nunrelated: the spec fails on main too'),
    'the spec fails on main too',
  );
  assert.equal(parseUnrelated('UNRELATED:   spaced  '), 'spaced');
});

test('the worker reads the last unrelated marker line when the fixer quoted the rule earlier', () => {
  assert.equal(
    parseUnrelated('unrelated: <one sentence>\nchecked\nunrelated: main fails too'),
    'main fails too',
  );
});

test('the worker finds no unrelated failure in a reply without the marker', () => {
  assert.equal(parseUnrelated('commit: fix: the thing'), undefined);
  assert.equal(parseUnrelated('unrelated:   '), undefined);
  assert.equal(parseUnrelated(''), undefined);
});

test('the worker finds no unrelated failure in a bare marker line followed by a commit line', () => {
  assert.equal(
    parseUnrelated('Fixed the test.\nunrelated:\ncommit: fix: guard the null body'),
    undefined,
  );
  assert.equal(parseUnrelated('unrelated:   \n\ncommit: fix: guard'), undefined);
});

test('the worker treats a placeholder unrelated value as no dispute', () => {
  for (const value of ['none', 'None', 'NONE', 'n/a', 'N/A', '-', ' none ']) {
    assert.equal(parseUnrelated(`fixed it\nunrelated: ${value}`), undefined, value);
  }
});

test('the worker reads the settled note from the last resolved marker line', () => {
  assert.equal(
    parseResolved('resolved: <how>\nran it\nresolved: the test failed before the fix'),
    'the test failed before the fix',
  );
  assert.equal(parseResolved('resolved:   '), undefined);
  assert.equal(parseResolved('unrelated: wrong'), undefined);
});

test('the worker treats a placeholder resolved value as no settlement', () => {
  for (const value of ['none', 'None', 'NONE', 'n/a', 'N/A', '-', ' none ']) {
    assert.equal(parseResolved(`fixed it\nresolved: ${value}`), undefined, value);
  }
});

test('the worker finds no settled note in a bare resolved line followed by a commit line', () => {
  assert.equal(parseResolved('resolved:\ncommit: fix: guard the null body'), undefined);
  assert.equal(parseResolved('resolved:\n\nAdded the test.'), undefined);
});

test('the worker drops each closing keyword with its issue reference from a commit subject', () => {
  assert.equal(withoutClosingReferences('fix: x (closes #7)', FALLBACK), 'fix: x');
  assert.equal(withoutClosingReferences('fix: x, fixes #7 and resolves #8', FALLBACK), 'fix: x');
  assert.equal(withoutClosingReferences('feat: y Closed: owner/repo#3', FALLBACK), 'feat: y');
  assert.equal(
    withoutClosingReferences('fix: z [resolve https://github.com/o/r/issues/4]', FALLBACK),
    'fix: z',
  );
  assert.equal(
    withoutClosingReferences('fix: #7 count the issues', FALLBACK),
    'fix: count the issues',
  );
  assert.equal(withoutClosingReferences('closes #7', FALLBACK), FALLBACK);
});

test('the worker drops a closing keyword with a GH-number reference in any case from a commit subject', () => {
  assert.equal(
    withoutClosingReferences('fix: handle empty input, closes GH-42', FALLBACK),
    'fix: handle empty input',
  );
  assert.equal(withoutClosingReferences('fix: x (Fixes gh-7)', FALLBACK), 'fix: x');
  assert.equal(withoutClosingReferences('fix: resolves GH-12', FALLBACK), FALLBACK);
});

test('the worker leaves no leading punctuation when a commit subject starts with a closing reference', () => {
  assert.equal(withoutClosingReferences('Fix #12: handle crash', FALLBACK), 'handle crash');
  assert.equal(withoutClosingReferences('Closes #5 - add retry', FALLBACK), 'add retry');
  assert.equal(withoutClosingReferences('Fix #4 — add retry', FALLBACK), 'add retry');
  assert.equal(withoutClosingReferences('Fix #4: -1 off by one', FALLBACK), '-1 off by one');
  assert.equal(withoutClosingReferences('Fix #3 (api): x', FALLBACK), FALLBACK);
});

test('the worker gives the fallback subject when only the commit type is left after it drops closing references', () => {
  assert.equal(withoutClosingReferences('fix: resolve #12', FALLBACK), FALLBACK);
  assert.equal(withoutClosingReferences('feat(api): closes #7', FALLBACK), FALLBACK);
  assert.equal(withoutClosingReferences('fix: fix #7', FALLBACK), FALLBACK);
  assert.equal(withoutClosingReferences('fix: #7', FALLBACK), FALLBACK);
  assert.equal(withoutClosingReferences('fix!: closes #7', FALLBACK), FALLBACK);
});

test('the worker keeps a commit subject with no closing reference', () => {
  assert.equal(
    withoutClosingReferences('fix: resolve issue #7', FALLBACK),
    'fix: resolve issue #7',
  );
  assert.equal(
    withoutClosingReferences('fix: close the socket (refs #7)', FALLBACK),
    'fix: close the socket (refs #7)',
  );
});

test('the worker keeps a commit subject whose number is followed by word characters', () => {
  for (const subject of [
    'fix: resolve #1password sync',
    'feat: close #12th item',
    'fix: fixes #12345abc',
    'fix: closes GH-12x thing',
    'fix: closes o/r#3b thing',
    'fix: closes https://github.com/o/r/issues/4a thing',
  ]) {
    assert.equal(withoutClosingReferences(subject, FALLBACK), subject);
  }
});

test('the worker finds no dispute when a fixer that fixed the cause wrote a prose unrelated line before its closing lines', () => {
  const reply =
    'Unrelated: I also saw a flaky test in foo.\nThe fix guards the null body.\n\ncommit: fix: guard the null body';
  assert.equal(parseUnrelated(reply), undefined);
  assert.equal(parseResolved(reply.replace('Unrelated', 'Resolved')), undefined);
  assert.equal(parseCommitSubject(reply, FALLBACK), 'fix: guard the null body');
});

test('the worker reads an unrelated marker in the closing lines next to the commit line', () => {
  assert.equal(
    parseUnrelated('Checked main.\n\nunrelated: main fails too\n\ncommit: fix: none'),
    'main fails too',
  );
  assert.equal(
    parseResolved('Ran it.\nresolved: the test fails before the fix\n'),
    'the test fails before the fix',
  );
});

test('the worker treats a placeholder with a trailing full stop or exclamation mark as no dispute', () => {
  for (const value of ['none.', 'None!', 'N/A.', '-.', 'none. ']) {
    assert.equal(parseUnrelated(`fixed it\nunrelated: ${value}`), undefined, value);
    assert.equal(parseResolved(`fixed it\nresolved: ${value}`), undefined, value);
  }
});

test('the worker reads a marker line that the agent wrapped in backticks', () => {
  assert.equal(parseCommitSubject('Done.\n`commit: feat: x`', FALLBACK), 'feat: x');
  assert.equal(parseUnrelated('Checked.\n``unrelated: main fails too``'), 'main fails too');
  assert.equal(
    parseResolved('Ran it.\n`resolved: the test fails before`'),
    'the test fails before',
  );
  assert.equal(parseDone('Already there.\n`done: src/a.mts:3 does it`'), 'src/a.mts:3 does it');
  assert.deepEqual(parseQuestions('`question: 1. Which one?`'), ['Which one?']);
});

test('the worker reads an unrelated or resolved marker that the fixer put inside a code fence at the end of its reply', () => {
  assert.equal(parseUnrelated('Checked main.\n```\nunrelated: main fails\n```'), 'main fails');
  assert.equal(
    parseResolved('Ran it.\n```text\nresolved: the test fails before\n```\n'),
    'the test fails before',
  );
  assert.equal(
    parseUnrelated(
      '```\nUnrelated: a flaky test in foo.\n```\nThe fix guards it.\ncommit: fix: guard',
    ),
    undefined,
  );
});
