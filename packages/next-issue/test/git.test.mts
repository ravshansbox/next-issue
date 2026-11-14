import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitAll } from '../src/git-commit.mts';
import {
  discardChanges,
  disputeBranches,
  isAncestor,
  isDirty,
  latestSubject,
  parseRemote,
  push,
  repoRoot,
  revision,
  setAside,
} from '../src/git.mts';
import { addWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';

test('parseRemote reads every remote form', () => {
  const expected = { owner: 'acme', name: 'tool' };
  assert.deepEqual(parseRemote('git@github.com:acme/tool.git'), expected);
  assert.deepEqual(parseRemote('git@github.com:acme/tool'), expected);
  assert.deepEqual(parseRemote('ssh://git@github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('https://github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('http://github.com/acme/tool\n'), expected);
});

test('a user in a linked worktree of a bare repository gets the root of that worktree', async () => {
  const { repo } = await clones();
  const bare = `${repo.root}.bare.git`;
  await git(repo.root, 'clone', '-q', '--bare', repo.root, bare);
  const linked = join(bare, '..', 'linked');
  await git(bare, 'worktree', 'add', '-q', linked);
  await mkdir(join(linked, 'sub'));
  assert.equal(await repoRoot(join(linked, 'sub')), await realpath(linked));
});

test('parseRemote refuses an unknown form', () => {
  assert.throws(() => parseRemote('acme/tool'), /Cannot parse/);
});

test('a pull request head that lags the pushed commit counts as an ancestor, but a commit someone else pushed does not', async () => {
  const { repo, other } = await clones();
  const lagging = await revision(repo.root);
  const pushed = await commit(repo.root, 'b.txt');
  const foreign = await commit(other, 'c.txt');
  assert.equal(await isAncestor(repo.root, lagging, pushed), true);
  assert.equal(await isAncestor(repo.root, foreign, pushed), false);
});

test('latestSubject gives the subject of the newest commit ahead of the base, and nothing on a branch that is not ahead', async () => {
  const { repo } = await clones();
  assert.equal(await latestSubject(repo.root, 'main', 'origin'), undefined);
  await commit(repo.root, 'b.txt');
  await commit(repo.root, 'c.txt');
  assert.equal(await latestSubject(repo.root, 'main', 'origin'), 'c.txt');
});

test('push with force replaces a remote branch that the base reset left behind', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await commit(path, 'old.txt');
  await push(path, 'origin', '3');
  await git(path, 'reset', '-q', '--hard', 'origin/main');
  const fixed = await commit(path, 'fix.txt');
  await assert.rejects(push(path, 'origin', '3'));
  await push(path, 'origin', '3', true);
  assert.equal(
    await git(repo.root, 'ls-remote', 'origin', 'refs/heads/3'),
    `${fixed}\trefs/heads/3`,
  );
});

test('discardChanges puts back a tracked file and removes a new one', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  await writeFile(join(path, 'a.txt'), 'the reviewer wrote this\n');
  await writeFile(join(path, 'notes.md'), 'scratch\n');
  assert.equal(await isDirty(path), true);
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await isDirty(path), false);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(existsSync(join(path, 'notes.md')), false);
  assert.equal(await revision(path), head);
});

test('discardChanges throws away a change that the index holds', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  await writeFile(join(path, 'a.txt'), 'tampered\n');
  await git(path, 'add', 'a.txt');
  await writeFile(join(path, 'notes.md'), 'scratch\n');
  await git(path, 'add', 'notes.md');
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await isDirty(path), false);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(existsSync(join(path, 'notes.md')), false);
  assert.equal(await revision(path), head);
});

test('discardChanges undoes a commit that the reviewer made', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  await writeFile(join(path, 'a.txt'), 'the reviewer committed this\n');
  await git(path, 'commit', '-q', '-am', 'reviewer commit');
  assert.equal(await isDirty(path), false);
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await revision(path), head);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'a.txt\n');
});

test('setAside moves a commit of the fixer to another branch and leaves nothing for a later commit to sweep up', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  const disputed = await commit(path, 'fixer.txt');
  await setAside(path, head, '3-dispute-1');
  assert.equal(await revision(path), head);
  assert.equal(await git(path, 'rev-parse', '3-dispute-1'), disputed);
  assert.equal(existsSync(join(path, 'fixer.txt')), false);
  assert.equal(await commitAll(path, 'a later fix'), false);
});

test('setAside moves a commit of the fixer that the fixer edited after and keeps both in the worktree', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  const disputed = await commit(path, 'fixer.txt');
  await writeFile(join(path, 'a.txt'), 'the fixer left this\n');
  await setAside(path, head, '3-dispute-1');
  assert.equal(await revision(path), head);
  assert.equal(await git(path, 'rev-parse', '3-dispute-1'), disputed);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'the fixer left this\n');
  assert.equal(await readFile(join(path, 'fixer.txt'), 'utf8'), 'fixer.txt\n');
});

test('setAside moves a commit of the fixer whose file the fixer then edited again', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const head = await revision(path);
  await writeFile(join(path, 'a.txt'), 'the fixer committed this\n');
  await git(path, 'commit', '-q', '-am', 'fixer commit');
  const disputed = await revision(path);
  await writeFile(join(path, 'a.txt'), 'the fixer left this\n');
  await setAside(path, head, '3-dispute-1');
  assert.equal(await revision(path), head);
  assert.equal(await git(path, 'rev-parse', '3-dispute-1'), disputed);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'the fixer left this\n');
});

test('disputeBranches lists the dispute branches of an issue only', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'branch', '3-dispute-1');
  await git(path, 'branch', '3-dispute-2');
  await git(path, 'branch', '30-dispute-1');
  assert.deepEqual(await disputeBranches(repo, '3'), ['3-dispute-1', '3-dispute-2']);
});

test('discardChanges keeps an ignored file and reports a clean worktree', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await writeFile(join(path, '.gitignore'), 'deps/\n');
  await git(path, 'add', '.gitignore');
  await git(path, 'commit', '-q', '-m', 'ignore deps');
  await mkdir(join(path, 'deps'));
  await writeFile(join(path, 'deps', 'pkg.txt'), 'installed\n');
  assert.equal(await discardChanges(path, await revision(path)), false);
  assert.equal(existsSync(join(path, 'deps', 'pkg.txt')), true);
});

test('a reviewer that leaves the worktree on a detached HEAD gets branch 3 put back, so a later fixer commit moves branch 3', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const before = await commit(path, 'implementer.txt');
  await git(path, 'checkout', '-q', '--detach', 'origin/main');
  assert.equal(await discardChanges(path, before, '3'), true);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), before);
  const fixed = await commit(path, 'fixer.txt');
  assert.equal(await git(path, 'rev-parse', '3'), fixed);
});

test('a reviewer that checks out another local branch leaves that branch where it was and gets branch 3 put back', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const before = await commit(path, 'implementer.txt');
  await git(path, 'branch', 'other', 'origin/main');
  const other = await git(path, 'rev-parse', 'other');
  await git(path, 'checkout', '-q', 'other');
  assert.equal(await discardChanges(path, before, '3'), true);
  assert.equal(await git(path, 'rev-parse', 'other'), other);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), before);
});

test('a fixer commit made after a reviewer detached HEAD is still on branch 3 when the issue resumes', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const before = await commit(path, 'implementer.txt');
  await git(path, 'checkout', '-q', 'HEAD~1');
  await discardChanges(path, before, '3');
  const fixed = await commit(path, 'fixer.txt');
  const { path: resumed } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await realpath(resumed), await realpath(path));
  assert.equal(await git(resumed, 'branch', '--show-current'), '3');
  assert.equal(await revision(resumed), fixed);
  assert.equal(existsSync(join(resumed, 'fixer.txt')), true);
});
