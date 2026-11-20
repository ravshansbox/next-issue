import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { clones, commit, git } from './clones.mts';
import { harness, ISSUE } from './harness.mts';
import { useGit } from './real-git.mts';
import { pendingIssues } from '../src/worker/pending.mts';
import { processIssue } from '../src/worker/pipeline.mts';

async function personWorktree(): Promise<{ root: string; mine: string; head: string }> {
  const { repo } = await clones();
  const mine = join(repo.root, '.claude', 'worktrees', '7');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '7', mine, 'origin/main');
  const head = await commit(mine, 'mine.txt');
  return { root: repo.root, mine: await realpath(mine), head };
}

async function claim(t: TestContext, root: string, labels: string[]) {
  const target = await harness(t, { root, issue: { ...ISSUE, labels } });
  useGit(target, async () => undefined);
  return { target, report: await target.run() };
}

test('a person whose clean worktree at .claude/worktrees/7 holds branch 7 keeps it and the branch when a run claims issue 7 and hands it over', async (t) => {
  const { root, mine, head } = await personWorktree();
  const { target, report } = await claim(t, root, ['status:todo']);
  assert.equal(report.outcome, 'error');
  assert.match(report.reason ?? '', new RegExp(`worktree at ${mine} has branch 7 checked out`));
  assert.deepEqual(target.prompts, []);
  assert.equal(existsSync(mine), true);
  assert.equal(await git(mine, 'branch', '--show-current'), '7');
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), head);
});

test('a person who answers the hand-over of issue 7 without moving their worktree off branch 7 gets it refused again, with the worktree kept', async (t) => {
  const { root, mine, head } = await personWorktree();
  await claim(t, root, ['status:todo']);
  const { target, report } = await claim(t, root, []);
  assert.equal(report.outcome, 'error');
  assert.match(report.reason ?? '', new RegExp(`worktree at ${mine} has branch 7 checked out`));
  assert.deepEqual(target.prompts, []);
  assert.equal(existsSync(mine), true);
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), head);
});

test('a person who closes issue 7 after it was refused for their worktree on branch 7 keeps the worktree and branch while the next run removes the state file', async (t) => {
  const { root, mine, head } = await personWorktree();
  await claim(t, root, ['status:todo']);
  const target = await harness(t, { root, open: [], closed: [ISSUE], disputes: ['7-dispute-1'] });
  useGit(target, async () => undefined);
  const reports = [];
  for (const issue of await pendingIssues(target.context)) {
    reports.push(await processIssue(target.context, issue));
  }
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['skipped'],
  );
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, []);
  assert.equal(existsSync(mine), true);
  assert.equal(await git(mine, 'branch', '--show-current'), '7');
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), head);
});

test('a person whose worktree holds branch 7 keeps it and the branch when a run finds issue 7 closed right before the claim with no saved state', async (t) => {
  const { root, mine, head } = await personWorktree();
  const target = await harness(t, { root, closed: [ISSUE], disputes: ['7-dispute-1'] });
  useGit(target, async () => undefined);
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, []);
  assert.equal(existsSync(mine), true);
  assert.equal(await git(mine, 'branch', '--show-current'), '7');
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), head);
});
