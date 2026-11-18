import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/shared/config.mts';
import type { Issue } from '../src/shared/github.mts';
import { stateDir } from '../src/shared/state.mts';
import { upcomingIssues } from '../src/worker/upcoming.mts';
import { ISSUE } from './harness.mts';
import { tempDir } from './temp-dir.mts';

function issue(number: number, labels: string[] = ['status:todo']): Issue {
  return { ...ISSUE, number, title: `Title ${number}`, labels };
}

test('the worker lists the fresh issues with the ready label in the order it claims them, with the blocked ones apart with their blockers', async () => {
  const root = await tempDir();
  await mkdir(stateDir(root));
  await writeFile(join(stateDir(root), '5.json'), JSON.stringify({ issue: 5 }));
  const repo = { owner: 'acme', name: 'tool', root };
  const config = await loadConfig(root);
  const asked: string[][] = [];
  const upcoming = await upcomingIssues(repo, config, {
    openIssues: async (_repo, _limit, labels) => {
      asked.push(labels);
      return [
        issue(3),
        issue(4),
        issue(5),
        issue(6, ['status:todo', 'status:in-progress']),
        issue(7, ['status:todo', 'status:blocked']),
        issue(8),
      ];
    },
    openBlockers: async (_repo, number) => (number === 4 ? ['#2', 'other/repo#9'] : []),
  });
  assert.deepEqual(asked, [['status:todo']]);
  assert.deepEqual(upcoming, {
    claimable: [
      { issue: 3, title: 'Title 3' },
      { issue: 8, title: 'Title 8' },
    ],
    blocked: [{ issue: 4, title: 'Title 4', blockers: ['#2', 'other/repo#9'] }],
  });
});
