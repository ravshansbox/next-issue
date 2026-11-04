import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mts';
import type { Comment, Issue } from '../src/github.mts';
import { waitingQuestions } from '../src/handover.mts';
import { STATE_DIR } from '../src/state.mts';
import { tempDir } from './temp-dir.mts';

function issue(number: number, title: string): Issue {
  return { number, title, body: '', createdAt: '2026-11-01T00:00:00Z', labels: [] };
}

test('the worker lists each open issue that waits for a person with the reason and the url of its hand-over', async () => {
  const root = await tempDir();
  await mkdir(join(root, STATE_DIR));
  await writeFile(
    join(root, STATE_DIR, '8.json'),
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
  const threads: Record<number, Comment[]> = {
    7: [
      { author: 'bot', body: 'next-issue needs help: old', url: 'u1' },
      {
        author: 'bot',
        body: 'next-issue needs help: The implementer produced no change.',
        url: 'u2',
      },
      { author: 'stranger', body: 'next-issue needs help: fake', url: 'u3' },
    ],
    80: [
      { author: 'bot', body: 'next-issue needs help: The reviewer gave no verdict.', url: 'u4' },
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
      labels: { needsHuman: config.labels.needsHuman, skip: config.labels.skip },
    },
    {
      issue: 8,
      title: 'Eight',
      reason: 'The reviewer gave no verdict.',
      url: 'u4',
      repo: 'acme/tool',
      pr: 80,
      labels: { needsHuman: config.labels.needsHuman, skip: config.labels.skip },
    },
    {
      issue: 9,
      title: 'Nine',
      reason: '',
      url: '',
      repo: 'acme/tool',
      labels: { needsHuman: config.labels.needsHuman, skip: config.labels.skip },
    },
  ]);
  assert.equal(mostReading, 1);
});
