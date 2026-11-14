import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HookError } from '../src/git-commit.mts';
import { pushToBase, revertOnBase, squashOnto } from '../src/git-land.mts';
import { commitMerge, startMerge } from '../src/git-merge.mts';
import { isLanded } from '../src/git.mts';
import { addWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';

async function branch(): Promise<{ path: string; other: string }> {
  const { repo, other } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await commit(path, 'b.txt');
  await commit(path, 'c.txt');
  return { path, other };
}

test('squashOnto makes one commit on top of the base, and pushToBase lands it there', async () => {
  const { path, other } = await branch();
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await startMerge(path, 'main', 'origin'), []);
  assert.equal(await commitMerge(path, [], 'chore: merge'), true);
  assert.equal(await squashOnto(path, 'main', 'origin', 'feat: add b and c'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'feat: add b and c');
  assert.equal(await pushToBase(path, 'origin', 'main'), true);
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'rev-parse', 'HEAD'), await git(path, 'rev-parse', 'HEAD'));
});

test('squashOnto makes no commit for a change that the base already holds', async () => {
  const { path } = await branch();
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  const head = await git(path, 'rev-parse', 'HEAD');
  assert.equal(await squashOnto(path, 'main', 'origin', 'feat: nothing'), false);
  assert.equal(await git(path, 'rev-parse', 'HEAD'), head);
});

test('squashOnto that a pre-commit hook stops keeps the branch head, and a retry still squashes onto the base', async () => {
  const { path } = await branch();
  const head = await git(path, 'rev-parse', 'HEAD');
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho lint fails >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  await assert.rejects(squashOnto(path, 'main', 'origin', 'feat: add b and c'), HookError);
  assert.equal(await git(path, 'rev-parse', 'HEAD'), head);
  assert.equal(await isLanded(path, 'main', 'origin'), false);
  await rm(join(hooks, 'pre-commit'));
  assert.equal(await squashOnto(path, 'main', 'origin', 'feat: add b and c'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'feat: add b and c');
});

test('pushToBase refuses a change that is behind the base', async () => {
  const { path, other } = await branch();
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.equal(await pushToBase(path, 'origin', 'main'), false);
});

test('revertOnBase pushes a revert to the base and leaves the change on the branch on top of it', async () => {
  const { path, other } = await branch();
  await squashOnto(path, 'main', 'origin', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  const landed = await git(path, 'rev-parse', 'HEAD');
  const pushed = await revertOnBase(path, {
    base: 'main',
    remote: 'origin',
    branch: '3',
    shas: [landed],
    message: 'revert: issue #3',
    reapply: 'feat: add b and c',
  });
  assert.equal(pushed, true);
  await git(other, 'pull', '-q', 'origin', 'main');
  assert.equal(await git(other, 'log', '-1', '--format=%s'), 'revert: issue #3');
  await assert.rejects(readFile(join(other, 'b.txt')));
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD^'), await git(other, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'b.txt\n');
});

test('revertOnBase that cannot push puts the branch back as it was', async () => {
  const { path, other } = await branch();
  await squashOnto(path, 'main', 'origin', 'feat: add b and c');
  await pushToBase(path, 'origin', 'main');
  const landed = await git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, 'stray.txt'), 'x\n');
  await git(other, 'pull', '-q', 'origin', 'main');
  await commit(other, 'd.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(path, 'remote', 'set-url', '--push', 'origin', join(path, 'missing.git'));
  const pushed = await revertOnBase(path, {
    base: 'main',
    remote: 'origin',
    branch: '3',
    shas: [landed],
    message: 'revert: issue #3',
    reapply: 'feat: add b and c',
  });
  assert.equal(pushed, false);
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), '3');
  assert.equal(await git(path, 'rev-parse', 'HEAD'), landed);
});

test('isLanded tells a branch whose head the base already holds from one with a commit the base lacks', async () => {
  const { path, other } = await branch();
  assert.equal(await isLanded(path, 'main', 'origin'), false);
  assert.equal(await pushToBase(path, 'origin', 'main'), true);
  await commit(other, 'd.txt');
  await git(other, 'pull', '-q', '--rebase', 'origin', 'main');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(path, 'fetch', '-q', 'origin');
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  assert.equal(await isLanded(path, 'main', 'origin'), true);
  await commit(path, 'e.txt');
  assert.equal(await isLanded(path, 'main', 'origin'), false);
});
