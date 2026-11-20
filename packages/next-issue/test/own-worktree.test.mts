import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { clones, commit, git } from './clones.mts';
import { harness, ISSUE } from './harness.mts';
import { landedFiles, useGit } from './real-git.mts';
import { newState } from '../src/shared/state.mts';
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

async function keptBranches(root: string): Promise<string[]> {
  const list = await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/7-kept-*');
  return list === '' ? [] : list.split('\n');
}

test('a person who moves their worktree off branch 7 and answers the hand-over keeps their unpushed commit on a 7-kept branch while issue 7 starts from the remote base', async (t) => {
  const { root, mine, head } = await personWorktree();
  await claim(t, root, ['status:todo']);
  await git(mine, 'checkout', '-q', '--detach');
  await claim(t, root, []);
  assert.deepEqual(await keptBranches(root), [`7-kept-${head.slice(0, 7)}`]);
  assert.equal(await git(root, 'rev-parse', `7-kept-${head.slice(0, 7)}`), head);
  assert.equal(await git(root, 'rev-parse', '7'), await git(root, 'rev-parse', 'origin/main'));
});

test('a person who pushed branch 7, moves their worktree off it and answers the hand-over keeps their unpushed commit on a 7-kept branch while issue 7 starts from the remote branch', async (t) => {
  const { root, mine } = await personWorktree();
  await git(mine, 'push', '-q', 'origin', '7');
  const head = await commit(mine, 'unpushed.txt');
  await claim(t, root, ['status:todo']);
  await git(mine, 'checkout', '-q', '--detach');
  await claim(t, root, []);
  assert.deepEqual(await keptBranches(root), [`7-kept-${head.slice(0, 7)}`]);
  assert.equal(await git(root, 'rev-parse', `7-kept-${head.slice(0, 7)}`), head);
  const files = (await git(root, 'ls-tree', '--name-only', '7')).split('\n');
  assert.equal(files.includes('mine.txt'), true);
  assert.equal(files.includes('unpushed.txt'), false);
});

test('a run that claims issue 7 with a local branch 7 that has no commits beyond the remote base makes no 7-kept branch', async (t) => {
  const { repo } = await clones();
  await git(repo.root, 'branch', '7', 'origin/main');
  await claim(t, repo.root, ['status:todo']);
  assert.deepEqual(await keptBranches(repo.root), []);
});

async function resumeWithPersonWorktree(t: TestContext) {
  const { repo, other } = await clones();
  const mine = join(repo.root, '..', 'fix-7');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '7', mine, 'origin/main');
  const head = await commit(mine, 'mine.txt');
  await writeFile(join(mine, 'mine.txt'), 'edited\n');
  await writeFile(join(mine, 'scratch.txt'), 'scratch\n');
  const resume = async () => {
    const target = await harness(t, {
      root: repo.root,
      issue: { ...ISSUE, labels: [] },
      saved: { ...newState(ISSUE.number, '7'), handedOver: true },
    });
    useGit(target, async () => undefined);
    return { target, report: await target.run() };
  };
  return { other, mine: await realpath(mine), head, resume };
}

test('a person whose worktree at ../fix-7 holds branch 7 with a commit and uncommitted files keeps it all when a run resumes issue 7 and hands it over', async (t) => {
  const { mine, head, resume } = await resumeWithPersonWorktree(t);
  const { target, report } = await resume();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason ?? '', new RegExp(`worktree at ${mine} has branch 7 checked out`));
  assert.deepEqual(target.prompts, []);
  assert.deepEqual(target.deleted, []);
  assert.equal(await git(mine, 'branch', '--show-current'), '7');
  assert.equal(await git(mine, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(mine, 'mine.txt'), 'utf8'), 'edited\n');
  assert.equal(await readFile(join(mine, 'scratch.txt'), 'utf8'), 'scratch\n');
});

test('a person who moves their worktree at ../fix-7 off branch 7 gets issue 7 resumed and their commit landed without their uncommitted files', async (t) => {
  const { other, mine, resume } = await resumeWithPersonWorktree(t);
  await resume();
  await git(mine, 'checkout', '-q', '--detach');
  const { report } = await resume();
  assert.equal(report.outcome, 'done');
  const landed = await landedFiles(other);
  assert.equal(landed['mine.txt'], 'mine.txt');
  assert.equal(landed['scratch.txt'], undefined);
  assert.equal(await readFile(join(mine, 'scratch.txt'), 'utf8'), 'scratch\n');
});
