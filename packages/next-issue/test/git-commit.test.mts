import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { commitAll, HookError } from '../src/git-commit.mts';
import { addWorktree } from '../src/worktree.mts';
import { clones, git } from './clones.mts';

test('commitAll that a pre-commit hook stops throws a hook error with the hook output', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho lint fails >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'b.txt'), 'b\n');
  await assert.rejects(commitAll(path, 'a change'), (error) => {
    assert.ok(error instanceof HookError);
    assert.match(error.message, /lint fails/);
    return true;
  });
});

test('commitAll that a commit-msg hook stops throws a hook error with the hook output', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const hooks = join(path, '..', 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(
    join(hooks, 'commit-msg'),
    '#!/bin/sh\ngrep -q "^fix:" "$1" || { echo bad subject >&2; exit 1; }\n',
  );
  await chmod(join(hooks, 'commit-msg'), 0o755);
  await git(path, 'config', 'core.hooksPath', hooks);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'b.txt'), 'b\n');
  await assert.rejects(commitAll(path, 'a change'), (error) => {
    assert.ok(error instanceof HookError);
    assert.match(error.message, /bad subject/);
    return true;
  });
  assert.equal(await commitAll(path, 'fix: a change'), true);
  assert.equal(await git(path, 'log', '-1', '--format=%s'), 'fix: a change');
});

test('commitAll whose commit signing fails throws an error that is not a hook error', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await git(path, 'config', 'commit.gpgsign', 'true');
  await git(path, 'config', 'gpg.program', 'false');
  await writeFile(join(path, 'b.txt'), 'b\n');
  await assert.rejects(commitAll(path, 'a change'), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof HookError));
    assert.match(error.message, /sign/);
    return true;
  });
});

test('commitAll whose git add fails throws an error that is not a hook error', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await writeFile(join(path, 'b.txt'), 'b\n');
  const index = await git(path, 'rev-parse', '--git-path', 'index.lock');
  await writeFile(resolve(path, index), '');
  await assert.rejects(commitAll(path, 'a change'), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof HookError));
    return true;
  });
});
