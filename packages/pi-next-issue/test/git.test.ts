import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../src/git.ts';
import { tempFolder } from './temp-folder.ts';

test('a user in a subfolder of a repository gets the root of the repository', async () => {
  const root = fs.realpathSync(tempFolder());
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'sub'));
  assert.equal(await repoRoot(path.join(root, 'sub')), root);
});

test('a user in a linked worktree gets the root of the main worktree', async () => {
  const root = fs.realpathSync(tempFolder());
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const linked = path.join(root, '.worktrees', '42');
  execFileSync('git', ['worktree', 'add', '-q', '-b', '42', linked], { cwd: root });
  fs.mkdirSync(path.join(linked, 'sub'));
  assert.equal(await repoRoot(path.join(linked, 'sub')), root);
});

test('a user in a linked worktree of a bare repository gets the root of that worktree', async () => {
  const folder = fs.realpathSync(tempFolder());
  const root = path.join(folder, 'root');
  execFileSync('git', ['init', '-q', root]);
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const bare = path.join(folder, 'bare.git');
  execFileSync('git', ['clone', '-q', '--bare', root, bare]);
  const linked = path.join(folder, 'linked');
  execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: bare });
  fs.mkdirSync(path.join(linked, 'sub'));
  assert.equal(await repoRoot(path.join(linked, 'sub')), linked);
});

test('a user outside a repository gets an error', async () => {
  const folder = tempFolder();
  await assert.rejects(repoRoot(folder), /git rev-parse --show-toplevel failed/);
});
