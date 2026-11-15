import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HookError } from '../src/git-commit.mts';
import { abortMerge, commitMerge, type Merge, startMerge } from '../src/git-merge.mts';
import { isDirty, revision } from '../src/git.mts';
import { addWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';

function merge(before: string, files: string[], target = 'origin/main'): Merge {
  return { before, target, files };
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
  const started = await startMerge(path, 'main', 'origin');
  assert.deepEqual(started, {
    target: await git(path, 'rev-parse', 'origin/main'),
    files: [],
    unmarked: [],
  });
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
  const started = await startMerge(path, 'main', 'origin');
  assert.deepEqual(started.files, ['a.txt']);
  assert.deepEqual(started.unmarked, []);
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), false);
  await abortMerge(path, head);
  assert.equal(await revision(path), head);
  assert.equal(await isDirty(path), false);
  await assert.rejects(git(path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
});

test('startMerge lists a modify/delete or binary conflict, which holds no conflict marker, as unmarked', async () => {
  const { repo, other } = await clones();
  await writeFile(join(other, 'gone.txt'), 'start\n');
  await writeFile(join(other, 'img.bin'), Buffer.from([0, 1, 2]));
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', 'start');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(repo.root, 'fetch', '-q', 'origin');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'gone.txt'), 'branch\n');
  await writeFile(join(path, 'img.bin'), Buffer.from([0, 3, 4]));
  await git(path, 'commit', '-q', '-am', 'branch');
  await git(other, 'rm', '-q', 'gone.txt');
  await writeFile(join(other, 'img.bin'), Buffer.from([0, 5, 6]));
  await git(other, 'commit', '-q', '-am', 'base');
  await git(other, 'push', '-q', 'origin', 'main');
  const started = await startMerge(path, 'main', 'origin');
  assert.deepEqual(started.files, ['gone.txt', 'img.bin']);
  assert.deepEqual(started.unmarked, ['gone.txt', 'img.bin']);
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

async function fixerCommits(path: string, text: string): Promise<void> {
  await writeFile(join(path, 'a.txt'), text);
  await git(path, 'commit', '-q', '-am', 'fixer merge');
}

async function baseMoves(path: string, base: string): Promise<void> {
  await commit(base, 'c.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  await git(path, 'fetch', '-q', 'origin');
}

test('commitMerge keeps a merge that the fixer committed after the remote base moved on', async () => {
  const { path, base } = await diverged();
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'commit', '-q', '-am', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  const { target } = await startMerge(path, 'main', 'origin');
  await fixerCommits(path, 'branch and base\n');
  const merged = await revision(path);
  await baseMoves(path, base);
  assert.notEqual(await git(path, 'rev-parse', 'origin/main'), target);
  assert.equal(await commitMerge(path, merge(head, ['a.txt'], target), 'chore: merge'), false);
  assert.equal(await revision(path), merged);
});

test('commitMerge undoes a commit that the fixer committed without the merged base or with a conflict marker', async () => {
  const { path, base } = await diverged();
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'commit', '-q', '-am', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  const { target } = await startMerge(path, 'main', 'origin');
  await git(path, 'merge', '--abort');
  await fixerCommits(path, 'branch and base\n');
  assert.equal(await commitMerge(path, merge(head, ['a.txt'], target), 'chore: merge'), false);
  assert.equal(await revision(path), head);
  await startMerge(path, 'main', 'origin');
  await fixerCommits(path, '<<<<<<< HEAD\nbranch\n=======\nbase\n>>>>>>> main\n');
  assert.equal(await commitMerge(path, merge(head, ['a.txt'], target), 'chore: merge'), false);
  assert.equal(await revision(path), head);
  assert.equal(await isDirty(path), false);
});

test('startMerge reports a branch that already holds the base with no merge to commit', async () => {
  const { path, base } = await diverged();
  await commit(base, 'b.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  await startMerge(path, 'main', 'origin');
  assert.equal(await commitMerge(path, merge(await revision(path), []), 'chore: merge'), true);
  const head = await revision(path);
  assert.equal((await startMerge(path, 'main', 'origin')).files, undefined);
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

test('startMerge lists a text conflict in a file with a conflict-marker-size attribute as marked, and commitMerge refuses its markers', async () => {
  const { path, base } = await diverged();
  await writeFile(join(path, '.gitattributes'), '*.txt conflict-marker-size=10\n');
  await git(path, 'add', '.gitattributes');
  await git(path, 'commit', '-q', '-m', 'attributes');
  await writeFile(join(base, '.gitattributes'), '*.txt conflict-marker-size=10\n');
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'add', '-A');
  await git(base, 'commit', '-q', '-m', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  const started = await startMerge(path, 'main', 'origin');
  assert.deepEqual(started.files, ['a.txt']);
  assert.deepEqual(started.unmarked, []);
  assert.match(await readFile(join(path, 'a.txt'), 'utf8'), /^<{10} /m);
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), false);
});

for (const autoupdate of ['false', 'true']) {
  test(`startMerge ignores a recorded rerere resolution (autoupdate ${autoupdate}) and leaves the conflict markers for the fixer`, async () => {
    const { path, base } = await diverged();
    await git(path, 'config', 'rerere.enabled', 'true');
    await git(path, 'config', 'rerere.autoupdate', autoupdate);
    await writeFile(join(base, 'a.txt'), 'base\n');
    await git(base, 'commit', '-q', '-am', 'base');
    await git(base, 'push', '-q', 'origin', 'main');
    const head = await revision(path);
    await git(path, 'fetch', '-q', 'origin');
    await git(path, 'merge', '-q', 'origin/main').catch(() => undefined);
    await writeFile(join(path, 'a.txt'), 'resolved\n');
    await git(path, 'add', 'a.txt');
    await git(path, 'commit', '-q', '--no-edit');
    await git(path, 'reset', '-q', '--hard', head);
    const started = await startMerge(path, 'main', 'origin');
    assert.deepEqual(started.files, ['a.txt']);
    assert.deepEqual(started.unmarked, []);
    assert.match(await readFile(join(path, 'a.txt'), 'utf8'), /^<{7} /m);
  });
}

test('startMerge lists a text conflict as marked when the merged base adds a conflict-marker-size attribute, and commitMerge refuses its markers', async () => {
  const { path, base } = await diverged();
  await writeFile(join(base, '.gitattributes'), '*.txt conflict-marker-size=10\n');
  await writeFile(join(base, 'a.txt'), 'base\n');
  await git(base, 'add', '-A');
  await git(base, 'commit', '-q', '-m', 'base');
  await git(base, 'push', '-q', 'origin', 'main');
  const head = await revision(path);
  const started = await startMerge(path, 'main', 'origin');
  assert.deepEqual(started.files, ['a.txt']);
  assert.deepEqual(started.unmarked, []);
  assert.match(await readFile(join(path, 'a.txt'), 'utf8'), /^<{7} /m);
  assert.equal(await commitMerge(path, merge(head, ['a.txt']), 'chore: merge'), false);
});
