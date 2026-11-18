import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { commitMerge } from '../src/shared/git-merge.mts';
import { clones, git } from './clones.mts';
import { type Harness, harness } from './harness.mts';
import { type Files, pushBase, remoteMain, useGit, writeFiles } from './real-git.mts';
import { tempDir } from './temp-dir.mts';

type Stop = { fix: Files; base: Files; conflictFixer?: Files; hook?: boolean };

async function stoppedFixLanding(
  t: TestContext,
  stop: Stop,
): Promise<{ root: string; other: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const first = await harness(t, { root: repo.root, baseChecks: ['fail'] });
  useGit(first, async (worktree, call) => {
    if (call === 1) {
      await writeFiles(worktree, stop.fix);
      await pushBase(other, stop.base);
      return;
    }
    await writeFiles(worktree, stop.conflictFixer ?? {});
    first.stopNow();
    throw new Error('The run stopped.');
  });
  if (stop.hook === true) {
    const hooks = await tempDir();
    first.context.ports.commitMerge = async (cwd, merge, message) => {
      await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
      await chmod(join(hooks, 'pre-commit'), 0o755);
      await git(cwd, 'config', 'core.hooksPath', hooks);
      try {
        return await commitMerge(cwd, merge, message);
      } catch (error) {
        first.stopNow();
        throw error;
      }
    };
  }
  const stopped = await first.run();
  assert.equal(stopped.outcome, 'stopped');
  if (stop.hook === true) {
    await git(repo.root, 'config', '--unset', 'core.hooksPath');
  }
  await git(join(repo.root, '.worktrees', '7'), 'rev-parse', '--verify', 'MERGE_HEAD');
  return { root: repo.root, other };
}

async function resume(t: TestContext, root: string, resolved: Files): Promise<Harness> {
  const resumed = await harness(t, { root });
  useGit(resumed, (worktree) => writeFiles(worktree, resolved));
  return resumed;
}

test('a user who stops the run while the fixer resolves a conflict of a fix for main, and whose base then moves, gets only the fix landed by the next run with the new base commit kept', async (t) => {
  const { root, other } = await stoppedFixLanding(t, {
    fix: { 'f.txt': 'fix\n' },
    base: { 'f.txt': 'base\n' },
  });
  await pushBase(other, { 'g.txt': 'moved\n' });
  const moved = await remoteMain(other);
  const resumed = await resume(t, root, { 'f.txt': 'fix and base\n' });
  const report = await resumed.run();
  assert.equal(report.reason, undefined);
  assert.equal(report.outcome, 'done');
  const landed = await remoteMain(other);
  assert.equal(await git(other, 'rev-parse', `${landed}^`), moved);
  assert.equal(await git(other, 'show', `${landed}:g.txt`), 'moved');
  assert.equal(await git(other, 'show', `${landed}:f.txt`), 'fix and base');
});

test('a user who stops the run during the commit hook of a clean merge in a fix for main gets the fix landed by the next run with no hand-over', async (t) => {
  const { root, other } = await stoppedFixLanding(t, {
    fix: { 'f.txt': 'fix\n' },
    base: { 'g.txt': 'base\n' },
    hook: true,
  });
  const resumed = await resume(t, root, {});
  const report = await resumed.run();
  assert.equal(report.reason, undefined);
  assert.equal(report.outcome, 'done');
  assert.equal(report.halt, undefined);
  const landed = await remoteMain(other);
  assert.equal(await git(other, 'show', `${landed}:f.txt`), 'fix');
  assert.equal(await git(other, 'show', `${landed}:g.txt`), 'base');
});

test('a user who stops the run after the fixer cleared some conflict markers of a fix for main gets the fix landed by the next run with no merge conflict hand-over', async (t) => {
  const { root, other } = await stoppedFixLanding(t, {
    fix: { 'f.txt': 'fix\n', 'h.txt': 'fix\n' },
    base: { 'f.txt': 'base\n', 'h.txt': 'base\n' },
    conflictFixer: { 'f.txt': 'fix and base\n' },
  });
  const resumed = await resume(t, root, { 'f.txt': 'fix and base\n', 'h.txt': 'fix and base\n' });
  const report = await resumed.run();
  assert.equal(report.reason, undefined);
  assert.equal(report.outcome, 'done');
  const landed = await remoteMain(other);
  assert.equal(await git(other, 'show', `${landed}:f.txt`), 'fix and base');
  assert.equal(await git(other, 'show', `${landed}:h.txt`), 'fix and base');
});
