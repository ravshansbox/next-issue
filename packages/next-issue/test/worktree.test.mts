import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchName, isDirty, revision } from '../src/git.mts';
import { huntWorktree } from '../src/hunt.mts';
import { addWorktree, fastForwardBase, findWorktree, removeWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';

test('addWorktree takes a branch that exists only on the remote', async () => {
  const { repo, other } = await clones();
  await git(other, 'checkout', '-q', '-b', '3');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), pushed);
});

test('addWorktree fast-forwards a local branch that the remote left behind', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'branch', '3', 'main');
  await git(other, 'checkout', '-q', '-b', '3');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), pushed);
});

test('addWorktree starts a new branch from the base', async () => {
  const { repo } = await clones();
  const { path, baseUpdated } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), await revision(repo.root));
  assert.equal(baseUpdated, true);
});

test('a user who starts issue 3 afresh gets the base branch instead of a stale local branch 3', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  await commit(repo.root, 'stale.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(await revision(path), await git(repo.root, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
});

test('a user who starts issue 3 afresh gets the remote branch 3 instead of a stale local branch 3', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  await commit(repo.root, 'stale.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  await git(other, 'checkout', '-q', '-b', '3');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(await revision(path), pushed);
});

test('a user who starts issue 3 afresh while a stale worktree holds branch 3 gets the base branch in it', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '..', 'tool-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  await commit(old, 'stale.txt');
  await writeFile(join(old, 'scratch.txt'), 'scratch\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(await revision(path), await git(repo.root, 'rev-parse', 'origin/main'));
  assert.equal(await isDirty(path), false);
});

test('a user who resumes issue 3 keeps the work on local branch 3', async () => {
  const { repo } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  const kept = await commit(repo.root, 'kept.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), kept);
});

test('a user who resumes issue 3 whose local branch has no work of its own gets the current base', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'branch', '3', 'main');
  await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), await git(repo.root, 'rev-parse', 'origin/main'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
});

test('a user who starts issue 3 gets branch 3 in .worktrees/3 under the repository root', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, branchName(3), 'main', 'origin', true);
  assert.equal(path, join(repo.root, '.worktrees', '3'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
});

test('a user who resumes issue 3 on a saved branch gets that branch in the worktree', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), 'issue-3');
});

test('a user who resumes issue 3 while its old worktree holds the saved branch works in that worktree', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '..', 'tool-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', 'issue-3', old, 'origin/main');
  const { path } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  assert.equal(path, await findWorktree(repo, 'issue-3'));
  assert.equal(await git(path, 'branch', '--show-current'), 'issue-3');
  assert.equal(existsSync(join(repo.root, '.worktrees', '3')), false);
});

test('a user who resumes issue 3 while .worktrees/3 is left detached gets branch 3 back in it', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const kept = await commit(first, 'kept.txt');
  await git(first, 'checkout', '-q', '--detach', 'origin/main');
  await writeFile(join(first, 'stray.txt'), 'x\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, first);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
});

test('a user who resumes issue 3 while the hunt worktree holds branch 3 gets the work in .worktrees/3', async () => {
  const { repo } = await clones();
  const hunt = await huntWorktree(repo, 'main', 'origin');
  await git(hunt, 'checkout', '-q', '-b', '3');
  const kept = await commit(hunt, 'kept.txt');
  assert.equal(await findWorktree(repo, '3'), undefined);
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, join(repo.root, '.worktrees', '3'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
  assert.equal(await git(hunt, 'branch', '--show-current'), '');
});

test('a user whose issue ends gets the worktree that holds its branch removed', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '..', 'tool-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', 'issue-3', old, 'origin/main');
  const path = await findWorktree(repo, 'issue-3');
  assert.notEqual(path, undefined);
  assert.equal(await removeWorktree(repo, path!), true);
  assert.equal(existsSync(old), false);
  assert.equal(await findWorktree(repo, 'issue-3'), undefined);
});

test('addWorktree reports a base that it cannot fast-forward', async () => {
  const { repo, other } = await clones();
  await commit(repo.root, 'local.txt');
  await commit(other, 'remote.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const { path, baseUpdated } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(baseUpdated, false);
  assert.equal(await revision(path), await git(repo.root, 'rev-parse', 'origin/main'));
});

test('a user whose change landed from a worktree gets the local base moved to the remote base', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const landed = await commit(path, 'b.txt');
  await git(path, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  assert.equal(await fastForwardBase(repo, 'main', 'origin'), true);
  assert.equal(await git(repo.root, 'rev-parse', 'main'), landed);
});

test('a user whose local base holds its own commit keeps it after a change lands', async () => {
  const { repo, other } = await clones();
  const local = await commit(repo.root, 'local.txt');
  await commit(other, 'remote.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.equal(await fastForwardBase(repo, 'main', 'origin'), false);
  assert.equal(await git(repo.root, 'rev-parse', 'main'), local);
});
