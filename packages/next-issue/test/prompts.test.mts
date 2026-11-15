import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capDiff,
  fixPrompt,
  hookPrompt,
  huntPrompt,
  implementPrompt,
  reviewPrompt,
} from '../src/prompts.mts';
import { ISSUE } from './harness.mts';

test('capDiff keeps a diff that fits', () => {
  assert.equal(capDiff('abc', 3), 'abc');
  assert.equal(capDiff('', 10), '');
});

test('capDiff cuts a diff that is too long and says so', () => {
  const text = capDiff('abcdef', 3);
  assert.match(text, /^abc\n/);
  assert.match(text, /cut here, after 3 characters\./);
});

test('each fixer kind is offered the unrelated exit for its own cause', () => {
  const checks = fixPrompt(
    ISSUE,
    [],
    'The continuous integration checks failed.',
    'the logs',
    [],
    'checks',
  );
  const review = fixPrompt(
    ISSUE,
    [],
    'The reviewer requested changes.',
    'the findings',
    [],
    'review',
  );
  assert.match(checks, /unrelated: <one sentence on what fails/);
  assert.match(review, /unrelated: <one sentence on why the findings are wrong/);
});

test('a fixer for failed checks is told that a failure in a file of the change is never unrelated', () => {
  const checks = fixPrompt(ISSUE, [], 'checks failed', 'log', [], 'checks');
  assert.match(
    checks,
    /A failure in a file that this change added or changed is never unrelated\./,
  );
});

test('each fixer kind is told to write no unrelated line after it fixes the cause', () => {
  const checks = fixPrompt(
    ISSUE,
    [],
    'The continuous integration checks failed.',
    'the logs',
    [],
    'checks',
  );
  const review = fixPrompt(
    ISSUE,
    [],
    'The reviewer requested changes.',
    'the findings',
    [],
    'review',
  );
  assert.match(checks, /If you fix the cause, write no `unrelated` line\./);
  assert.match(review, /If you fix the findings, write no `unrelated` line\./);
});

test('the conflict fixer is told to remove the conflict markers and leave the merge to the harness', () => {
  const conflict = fixPrompt(
    ISSUE,
    [],
    'The pull request conflicts with its base.',
    'a.txt',
    [],
    'conflict',
  );
  assert.match(conflict, /## Detail\na\.txt/);
  assert.match(conflict, /remove every conflict marker/);
  assert.doesNotMatch(conflict, /unrelated:/);
});

test('the review fixer is told to dispute only when every finding is wrong', () => {
  const review = fixPrompt(
    ISSUE,
    [],
    'The reviewer requested changes.',
    'the findings',
    [],
    'review',
  );
  assert.match(review, /If every finding is wrong, change nothing/);
  assert.match(review, /If only some of the findings are wrong, fix the correct ones/);
});

test('the review fixer is told to end with a resolved line when every finding is settled with no code change', () => {
  const review = fixPrompt(
    ISSUE,
    [],
    'The reviewer requested changes.',
    'the findings',
    [],
    'review',
  );
  const checks = fixPrompt(ISSUE, [], 'The checks failed.', 'the logs', [], 'checks');
  assert.match(review, /resolved: <how the findings were settled>/);
  assert.doesNotMatch(checks, /resolved:/);
});

test('a later reviewer is told that a settled note answers every finding of its round', () => {
  const earlier = [
    'Round 1:\n- Show the test fail.\nThe fixer settled every finding of this round with no code change: the run failed before the fix',
  ];
  const prompt = reviewPrompt(ISSUE, [], 'diff', earlier);
  assert.match(
    prompt,
    /Withdraw every finding of that round if they are settled\. Repeat them all if they are not\./,
  );
});

test('the implementer and the fixer get the answer of a person to the hand-over under its own heading', () => {
  const reply = ['@owner: ready, take it'];
  const implement = implementPrompt(ISSUE, [], reply);
  const fix = fixPrompt(ISSUE, [], 'The reviewer requested changes.', 'x', [], 'review', reply);
  for (const prompt of [implement, fix]) {
    assert.match(prompt, /## Answer of a person to the hand-over\n[\s\S]*@owner: ready, take it/);
  }
  assert.doesNotMatch(implementPrompt(ISSUE, []), /hand-over/);
});

test('reviewPrompt asks for a full review when no earlier finding exists', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', []);
  assert.doesNotMatch(prompt, /Earlier findings/);
  assert.match(prompt, /Check correctness/);
});

test('reviewPrompt asks for the verdict as a json block at the end', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', []);
  assert.match(prompt, /End your final message with the result as a json block/);
  assert.match(prompt, /"severity": "blocking" or "minor"/);
  assert.doesNotMatch(prompt, /submit_result/);
});

test('reviewPrompt narrows a later round to the earlier findings', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', ['Round 1:\n- The count is wrong.']);
  assert.match(prompt, /## Earlier findings\nRound 1:\n- The count is wrong\./);
  assert.doesNotMatch(prompt, /Check correctness/);
});

test('a later reviewer is told that a dispute answers every finding of its round', () => {
  const earlier = [
    'Round 1:\n- The count is wrong.\n- The name is wrong.\nThe fixer disputed every finding of this round: both follow CONTRIBUTING.md',
  ];
  const prompt = reviewPrompt(ISSUE, [], 'diff', earlier);
  assert.match(prompt, /answers all of the findings of that round, not one of them\./);
  assert.match(prompt, /Withdraw every finding of that round if the dispute is correct\./);
  assert.doesNotMatch(reviewPrompt(ISSUE, [], 'diff', []), /Withdraw every finding/);
});

test('the implementer is told to write a failing test first and quote its output for a behaviour change', () => {
  const prompt = implementPrompt(ISSUE, []);
  assert.match(prompt, /For a behaviour change, write the test first/);
  assert.match(prompt, /quote its failing output in your final message/);
});

test('the implementer is told to ask numbered questions with lettered options instead of guessing when the issue is ambiguous', () => {
  const prompt = implementPrompt(ISSUE, []);
  assert.match(prompt, /Check the issue first\./);
  assert.match(
    prompt,
    /scope, the expected behaviour or the acceptance criteria are ambiguous, make no change and ask instead of guessing\./,
  );
  assert.match(prompt, /each question on its own line in the form `question: <n>\. <question>`/);
  assert.match(prompt, /label its options with letters and recommend one/);
});

test('reviewPrompt gives the reply of the implementer and asks for a finding when a behaviour change has no failing run', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', [], 'The test failed: expected 2, got 1.');
  assert.match(prompt, /## Reply of the implementer\nThe test failed: expected 2, got 1\./);
  assert.match(prompt, /Raise a finding when a behaviour change has no failing run/);
  assert.match(reviewPrompt(ISSUE, [], 'diff', []), /## Reply of the implementer\n\(no reply\)/);
});

test('a later reviewer gets the reply of the fixer and no new demand for a failing run', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', ['Round 1:\n- x'], 'The test failed first.');
  assert.match(prompt, /## Reply of the fixer\nThe test failed first\./);
  assert.doesNotMatch(prompt, /Raise a finding when a behaviour change has no failing run/);
});

test('every fixer kind gets the issue body and the writer comments', () => {
  const comments = ['@owner: Use the flag name --quiet.'];
  for (const kind of ['review', 'checks', 'conflict'] as const) {
    const prompt = fixPrompt(ISSUE, comments, 'The reason.', 'the detail', [], kind);
    assert.match(prompt, new RegExp(`# Issue #${ISSUE.number}: ${ISSUE.title}\n\n${ISSUE.body}`));
    assert.match(prompt, /## Comments\n@owner: Use the flag name --quiet\./);
  }
  const empty = fixPrompt({ ...ISSUE, body: '' }, [], 'The reason.', 'x', [], 'checks');
  assert.match(empty, /\(no description\)/);
});

test('the review fixer is told to quote the failing output of a test for a behaviour change', () => {
  const review = fixPrompt(ISSUE, [], 'The reviewer requested changes.', 'x', [], 'review');
  assert.match(review, /quote its failing output in your final message/);
});

test('the implementer and every fixer kind are told the engineering rules', () => {
  const prompts = [
    implementPrompt(ISSUE, []),
    ...(['review', 'checks', 'local', 'conflict'] as const).map((kind) =>
      fixPrompt(ISSUE, [], 'The reason.', 'the detail', [], kind),
    ),
  ];
  for (const prompt of prompts) {
    assert.match(
      prompt,
      /Update the documentation when you change behaviour or add or remove a feature\./,
    );
    assert.match(prompt, /Remove the tests of a feature or behaviour that you remove\./);
    assert.match(prompt, /Test behaviour that a user can observe/);
    assert.match(prompt, /names the actor, the action and the observable outcome/);
    assert.match(
      prompt,
      /Reuse existing code and patterns, stay consistent with the repository and pick the simpler option\./,
    );
    assert.match(
      prompt,
      /Check an API, a command or a url in the repository or its dependencies before you use it\. Do not invent one\./,
    );
  }
});

test('each editing and reviewing agent is told that the harness owns the workflow rules of AGENTS.md', () => {
  const prompts = [
    implementPrompt(ISSUE, []),
    hookPrompt(ISSUE, [], 'implementer', 'hook output'),
    fixPrompt(ISSUE, [], 'The reviewer requested changes.', 'the findings', [], 'review'),
    reviewPrompt(ISSUE, [], 'diff', []),
  ];
  for (const prompt of prompts) {
    assert.match(
      prompt,
      /The harness owns the issue, the worktree, the branch, git, the commit, the push and the checks\. The workflow rules of `AGENTS\.md` about these do not apply to you\./,
    );
    assert.match(
      prompt,
      /The other rules of `AGENTS\.md`, such as code conventions and test style, still apply\./,
    );
  }
});

test('the reviewer checks the engineering rules and asks for the evidence of each finding', () => {
  const prompt = reviewPrompt(ISSUE, [], 'diff', []);
  assert.match(prompt, /updates the documentation/);
  assert.match(prompt, /removes the tests of a removed feature/);
  assert.match(prompt, /names the actor, the action and the observable outcome/);
  assert.match(prompt, /reuses existing code and patterns/);
  assert.match(prompt, /invented API, command or url/);
  assert.match(
    prompt,
    /A missing documentation update or a test that is not observable is a finding\./,
  );
  const later = reviewPrompt(ISSUE, [], 'diff', ['Round 1:\n- x']);
  for (const each of [prompt, later]) {
    assert.match(
      each,
      /Give the file and line, or the command output, that supports each finding\./,
    );
  }
});

test('the hunter is told that the harness owns the worktree, git and the checks and still files issues with gh', () => {
  const prompt = huntPrompt(undefined, 'status:todo', '', 1, 'owner/repo');
  assert.match(
    prompt,
    /The harness owns the worktree, git and the checks\. The workflow rules of `AGENTS\.md` about these do not apply to you\./,
  );
  assert.match(
    prompt,
    /The other rules of `AGENTS\.md`, such as code conventions and test style, still apply\./,
  );
  assert.match(prompt, /gh issue create --repo owner\/repo/);
});
