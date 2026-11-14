import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HookError } from '../src/git-commit.mts';
import { abortMerge, commitMerge, type Merge, startMerge } from '../src/git-merge.mts';
import { isDirty, revision } from '../src/git.mts';
import { addWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';

function merge(before: string, files: string[]): Merge {
  return { before, base: 'main', remote: 'origin', files };
}

async function diverged(): Promise<{ path: string; base: string }> {
  const { repo, other } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'a.txt'), 'branch\n');
  await git(path, 'commit', '-q', '-am', 'branch');
  return { path, base: other };
}

test('startMerge merges a base that git can merge cleanly and commitMerge commits it with both parents', async () => {
  const { path, base } = await diverged();
  await commit(base, 'b.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  assert.deepEqual(await startMerge(path, 'main', 'origin'), []);
  assert.equal(await commitMerge(path, merge(head, []), 'chore: merge origin/main'), true);
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'chore: merge origin/main');
  assert.equal(await git(path, 'rev-parse', 'HEAD^1'), head);
  assert.equal(await git(path, 'rev-parse', 'HEAD^2'), await git(path, 'rev-parse', 'origin/main'));
  assert.equal(await isDirty(path), false);
});

test('startMerge lists the conflicted files, and commitMerge refuses them while they hold conflict markers', async () => {
  const { path, base } = await diverged();
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'commit', '-q', '-am', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  assert.deepEqual(await startMerge(path, 'main', 'origin'), ['a.txt']);
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), false);
  await abortMerge(path, head);
  assert.equal(await revision(path), head);
  assert.equal(await isDirty(path), false);
  await assert.rejects(git(path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
});

test('commitMerge commits a conflict that the fixer resolved, and refuses a merge that the fixer aborted', async () => {
  const { path, base } = await diverged();
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'commit', '-q', '-am', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  await startMerge(path, 'main', 'origin');
  await git(path, 'merge', '--abort');
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), false);
  await startMerge(path, 'main', 'origin');
  await writeFile(join(path, 'a.txt'), 'branch and base\n=======\n');
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^1'), head);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'branch and base\n=======\n');
});

test('startMerge reports a branch that already holds the base with no merge to commit', async () => {
  const { path, base } = await diverged();
  await commit(base, 'b.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  await startMerge(path, 'main', 'origin');
  assert.equal(await commitMerge(path, merge(await revision(path), []), 'chore: merge'), true);
  const head = await revision(path);
  assert.equal(await startMerge(path, 'main', 'origin'), undefined);
  assert.equal(await revision(path), head);
});

test('commitMerge that a pre-commit hook stops throws a hook error and keeps the merge in progress', async () => {
  const { path, base } = await diverged();
  await commit(base, 'b.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho lint fails >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  const head = await revision(path);
  await startMerge(path, 'main', 'origin');
  await assert.rejects(commitMerge(path, merge(head, []), 'chore: merge'), (error) => {
    assert.ok(error instanceof HookError);
    assert.match(error.message, /lint fails/);
    return true;
  });
  await git(path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
});
