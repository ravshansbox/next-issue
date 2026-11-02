import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ahead, cleanup, commit, diff, discard, parseRemote, push, worktree } from '../src/git.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): { root: string; remote: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-next-issue-git-'));
  const remote = path.join(top, 'remote.git');
  const root = path.join(top, 'work');
  git(top, 'init', '-q', '--bare', '-b', 'main', remote);
  git(top, 'clone', '-q', remote, root);
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'chore: start');
  git(root, 'push', '-q', 'origin', 'main');
  return { root, remote };
}

test('the runner reads the owner and name from ssh and https remotes', () => {
  assert.equal(parseRemote('git@github.com:owner/name.git'), 'owner/name');
  assert.equal(parseRemote('https://github.com/owner/name'), 'owner/name');
  assert.equal(parseRemote('https://GitHub.com/owner/name'), 'owner/name');
});

test('a github enterprise remote keeps its host in the repository name', () => {
  assert.equal(parseRemote('git@ghe.example.com:owner/name.git'), 'ghe.example.com/owner/name');
  assert.equal(parseRemote('https://ghe.example.com/owner/name.git'), 'ghe.example.com/owner/name');
  assert.equal(
    parseRemote('ssh://git@ghe.example.com:2222/owner/name.git'),
    'ghe.example.com/owner/name',
  );
});

test('a remote with a path prefix or a local path still gives the last two path segments', () => {
  assert.equal(parseRemote('https://github.com/prefix/owner/name.git'), 'owner/name');
  assert.equal(parseRemote('file:///srv/git/owner/name.git'), 'owner/name');
  assert.equal(parseRemote('/srv/git/owner/name.git'), 'owner/name');
});

test('an issue gets a worktree on its own branch that git ignores, and finds it again', async () => {
  const { root } = repository();
  const tree = await worktree(root, 'origin', 'main', 5, '5');
  assert.equal(fs.realpathSync(tree), fs.realpathSync(path.join(root, '.worktrees', '5')));
  assert.equal(git(tree, 'branch', '--show-current'), '5');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(
    fs.realpathSync(await worktree(root, 'origin', 'main', 5, '5')),
    fs.realpathSync(tree),
  );
});

test('work in the worktree is committed, pushed, diffed against the base and kept from a later discard', async () => {
  const { root, remote } = repository();
  const tree = await worktree(root, 'origin', 'main', 5, '5');
  assert.equal(await commit(tree, 'feat: nothing'), false);
  fs.writeFileSync(path.join(tree, 'b.txt'), 'b\n');
  assert.equal(await commit(tree, 'feat: add b'), true);
  await push(tree, 'origin', '5');
  assert.equal(git(remote, 'log', '-1', '--format=%s', '5'), 'feat: add b');
  assert.match(await diff(tree, 'origin', 'main'), /\+b/);
  fs.writeFileSync(path.join(tree, 'b.txt'), 'changed\n');
  fs.writeFileSync(path.join(tree, 'c.txt'), 'c\n');
  await discard(tree, 'origin', '5');
  assert.equal(fs.readFileSync(path.join(tree, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(tree, 'c.txt')), false);
});

test('the subject of the first commit ahead of the base is found, and nothing before a commit', async () => {
  const { root } = repository();
  const tree = await worktree(root, 'origin', 'main', 5, '5');
  assert.equal(await ahead(tree, 'origin', 'main'), undefined);
  fs.writeFileSync(path.join(tree, 'b.txt'), 'b\n');
  await commit(tree, 'feat: add b');
  fs.writeFileSync(path.join(tree, 'c.txt'), 'c\n');
  await commit(tree, 'fix: add c');
  assert.equal(await ahead(tree, 'origin', 'main'), 'feat: add b');
});

test('a reviewer change is discarded in a worktree made from the remote branch without an upstream', async () => {
  const { root } = repository();
  const tree = await worktree(root, 'origin', 'main', 5, '5');
  fs.writeFileSync(path.join(tree, 'b.txt'), 'b\n');
  await commit(tree, 'feat: add b');
  await push(tree, 'origin', '5');
  git(root, 'worktree', 'remove', '--force', tree);
  git(root, 'branch', '-D', '5');
  const again = await worktree(root, 'origin', 'main', 5, '5');
  fs.writeFileSync(path.join(again, 'b.txt'), 'changed\n');
  fs.writeFileSync(path.join(again, 'c.txt'), 'c\n');
  await discard(again, 'origin', '5');
  assert.equal(fs.readFileSync(path.join(again, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.existsSync(path.join(again, 'c.txt')), false);
});

test('a cleanup removes the worktree, the local branch and the remote branch', async () => {
  const { root, remote } = repository();
  const tree = await worktree(root, 'origin', 'main', 5, '5');
  fs.writeFileSync(path.join(tree, 'b.txt'), 'b\n');
  await commit(tree, 'feat: add b');
  await push(tree, 'origin', '5');
  await cleanup(root, 'origin', '5', tree);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(git(root, 'branch', '--list', '5'), '');
  assert.equal(git(remote, 'branch', '--list', '5'), '');
});
