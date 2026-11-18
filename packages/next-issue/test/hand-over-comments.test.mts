import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/shared/config.mts';
import type { Comment, Issue } from '../src/shared/github.mts';
import { waitingQuestions } from '../src/shared/hand-over-comments.mts';
import { stateDir } from '../src/shared/state.mts';
import { ISSUE } from './harness.mts';
import { tempDir } from './temp-dir.mts';

function issue(number: number, title: string): Issue {
  return { ...ISSUE, number, title };
}

test('the worker lists each open issue that waits for a person with the reason and the url of the hand-over on the issue', async () => {
  const root = await tempDir();
  await mkdir(stateDir(root));
  await writeFile(
    join(stateDir(root), '8.json'),
    JSON.stringify({
      issue: 8,
      phase: 'review',
      branch: '8',
      pr: 80,
      ciFixes: 0,
      reviewRounds: 0,
      reviewLog: [],
    }),
  );
  const repo = { owner: 'acme', name: 'tool', root };
  const config = await loadConfig(root);
  const questionLabels = {
    needsHuman: config.labels.needsHuman,
    skip: config.labels.skip,
    ready: config.labels.ready,
  };
  const threads: Record<number, Comment[]> = {
    7: [
      { author: 'bot', body: '### next-issue · Hand-over: needs help\n\nold', url: 'u1' },
      {
        author: 'bot',
        body: '### next-issue · Hand-over: needs help\n\nThe implementer produced no change.',
        url: 'u2',
      },
      { author: 'stranger', body: '### next-issue · Hand-over: needs help\n\nfake', url: 'u3' },
    ],
    8: [
      {
        author: 'bot',
        body: '### next-issue · Hand-over: needs help\n\nThe reviewer gave no verdict.',
        url: 'u4',
      },
    ],
    80: [
      {
        author: 'bot',
        body: '### next-issue · Hand-over: needs help\n\nOn the pull request.',
        url: 'u6',
      },
    ],
    9: [{ author: 'owner', body: 'A plain comment.', url: 'u5' }],
  };
  const labels: string[][] = [];
  let reading = 0;
  let mostReading = 0;
  const questions = await waitingQuestions(repo, config, {
    openIssues: async (_repo, _limit, given) => {
      labels.push(given);
      return [issue(7, 'Seven'), issue(8, 'Eight'), issue(9, 'Nine')];
    },
    threadComments: async (_repo, number) => {
      reading += 1;
      mostReading = Math.max(mostReading, reading);
      await new Promise((resolve) => setTimeout(resolve, 5));
      reading -= 1;
      return threads[number] ?? [];
    },
    canWrite: async (_repo, login) => login !== 'stranger',
  });
  assert.deepEqual(labels, [[config.labels.needsHuman]]);
  assert.deepEqual(questions, [
    {
      issue: 7,
      title: 'Seven',
      reason: 'The implementer produced no change.',
      url: 'u2',
      repo: 'acme/tool',
      labels: questionLabels,
    },
    {
      issue: 8,
      title: 'Eight',
      reason: 'The reviewer gave no verdict.',
      url: 'u4',
      repo: 'acme/tool',
      labels: questionLabels,
    },
    {
      issue: 9,
      title: 'Nine',
      reason: '',
      url: '',
      repo: 'acme/tool',
      labels: questionLabels,
    },
  ]);
  assert.equal(mostReading, 1);
});

test('the worker leaves out of the waiting questions an issue whose hand-over a writer has answered, and keeps one that only a stranger or the harness has answered', async () => {
  const root = await tempDir();
  const repo = { owner: 'acme', name: 'tool', root };
  const config = await loadConfig(root);
  const threads: Record<number, Comment[]> = {
    10: [
      { author: 'bot', body: '### next-issue · Hand-over: needs help\n\nAnswered.', url: 'u10' },
      { author: 'owner', body: 'Use the other api.', url: 'u11' },
    ],
    11: [
      {
        author: 'bot',
        body: '### next-issue · Hand-over: needs help\n\nStranger only.',
        url: 'u12',
      },
      { author: 'stranger', body: 'Try again.', url: 'u13' },
    ],
    12: [
      {
        author: 'bot',
        body: '### next-issue · Hand-over: needs help\n\nHarness only.',
        url: 'u14',
      },
      { author: 'bot', body: '### next-issue · Review: changes', url: 'u15' },
    ],
  };
  const questions = await waitingQuestions(repo, config, {
    openIssues: async () => [issue(10, 'Ten'), issue(11, 'Eleven'), issue(12, 'Twelve')],
    threadComments: async (_repo, number) => threads[number] ?? [],
    canWrite: async (_repo, login) => login !== 'stranger',
  });
  assert.deepEqual(
    questions.map((question) => [question.issue, question.url]),
    [
      [11, 'u12'],
      [12, 'u14'],
    ],
  );
});

test('the worker names the host of a GitHub Enterprise remote in the repository of each waiting question', async () => {
  const root = await tempDir();
  const repo = { host: 'github.example.com', owner: 'acme', name: 'tool', root };
  const config = await loadConfig(root);
  const questions = await waitingQuestions(repo, config, {
    openIssues: async () => [issue(7, 'Seven')],
    threadComments: async () => [
      { author: 'bot', body: '### next-issue · Hand-over: needs help\n\nStuck.', url: 'u1' },
    ],
    canWrite: async () => true,
  });
  assert.deepEqual(
    questions.map((question) => question.repo),
    ['github.example.com/acme/tool'],
  );
});

test('the worker finds a hand-over posted in the older one-line format, reads its reason, and keeps it waiting when only an older harness comment follows', async () => {
  const root = await tempDir();
  const repo = { owner: 'acme', name: 'tool', root };
  const config = await loadConfig(root);
  const threads: Record<number, Comment[]> = {
    7: [
      {
        author: 'bot',
        body: 'next-issue needs help: The limit was reached.',
        url: 'u1',
      },
      { author: 'bot', body: '### Review: approved', url: 'u2' },
      { author: 'bot', body: '### Fixer: no change\n\nNothing.', url: 'u3' },
      { author: 'bot', body: '### Already done\n\nDone.', url: 'u4' },
    ],
  };
  const questions = await waitingQuestions(repo, config, {
    openIssues: async () => [issue(7, 'Seven')],
    threadComments: async (_repo, number) => threads[number] ?? [],
    canWrite: async () => true,
  });
  assert.deepEqual(
    questions.map((question) => [question.issue, question.reason, question.url]),
    [[7, 'The limit was reached.', 'u1']],
  );
});
