import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerHandOver } from '../src/hand-overs.ts';

const QUESTION = {
  issue: 9,
  title: 'Stuck',
  reason: 'stuck',
  url: 'https://github.com/o/r/issues/9',
  repo: 'o/r',
  labels: { needsHuman: 'status:needs-human', skip: 'status:blocked', ready: 'status:todo' },
};

test('a person who gives up on a hand-over in a repository without the skip label creates it and swaps the labels', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return args[0] === 'label' && args[1] === 'list' ? '[]' : '';
  };
  await answerHandOver(gh, QUESTION, { kind: 'give-up' });
  assert.deepEqual(calls.slice(1), [
    ['label', 'create', '--repo', 'o/r', 'status:blocked'],
    [
      'issue',
      'edit',
      '--repo',
      'o/r',
      '9',
      '--remove-label',
      'status:needs-human',
      '--add-label',
      'status:blocked',
    ],
  ]);
});

test('a person who retries a hand-over with guidance posts it and swaps the label for the ready label', async () => {
  const calls: string[][] = [];
  await answerHandOver(
    async (args) => {
      calls.push(args);
      return '';
    },
    QUESTION,
    { kind: 'retry', guidance: 'Use the other API.' },
  );
  assert.deepEqual(calls, [
    ['issue', 'comment', '--repo', 'o/r', '9', '--body', 'Use the other API.'],
    [
      'issue',
      'edit',
      '--repo',
      'o/r',
      '9',
      '--remove-label',
      'status:needs-human',
      '--add-label',
      'status:todo',
    ],
  ]);
});
