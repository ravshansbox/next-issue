import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchName, isDirty, revision } from '../src/shared/git.mts';
import { huntWorktree } from '../src/shared/hunt.mts';
import {
  addWorktree,
  fastForwardBase,
  findWorktree,
  removeOldWorktrees,
  removeWorktree,
} from '../src/shared/worktree.mts';
import { clones, commit, git } from './clones.mts';

test('the worker takes a branch that exists only on the remote for the worktree', async () => {
  const { repo, other } = await clones();
  await git(other, 'checkout', '-q', '-b', '3');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), pushed);
});

test('the worker fast-forwards a local branch that the remote left behind for the worktree', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'branch', '3', 'main');
  await git(other, 'checkout', '-q', '-b', '3');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), pushed);
});

test('a user who starts issue 3 after its remote branch was deleted gets the base, not the deleted branch', async () => {
  const { repo, other } = await clones();
  await git(other, 'checkout', '-q', '-b', '3');
  await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', '3');
  await git(repo.root, 'fetch', '-q', 'origin');
  await git(other, 'push', '-q', 'origin', '--delete', '3');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(await revision(path), await git(repo.root, 'rev-parse', 'origin/main'));
});

test('a user whose local branch 3 has drifted from the remote branch 3 is told it was not fast-forwarded', async () => {
  const { repo, other } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  const kept = await commit(repo.root, 'local.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  await git(other, 'checkout', '-q', '-b', '3');
  await commit(other, 'remote.txt');
  await git(other, 'push', '-q', 'origin', '3');
  const { path, branchUpdated } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(branchUpdated, false);
  assert.equal(await revision(path), kept);
});

test('the worker starts a new branch from the base for the worktree', async () => {
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

test('a user whose own worktree at .claude/worktrees/3 holds branch 3 keeps it, its edits and the branch when issue 3 starts afresh', async () => {
  const { repo } = await clones();
  const mine = join(repo.root, '.claude', 'worktrees', '3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', mine, 'origin/main');
  const head = await commit(mine, 'mine.txt');
  await writeFile(join(mine, 'mine.txt'), 'edited\n');
  await writeFile(join(mine, 'untracked.txt'), 'untracked\n');
  await assert.rejects(
    addWorktree(repo, 3, '3', 'main', 'origin', true),
    new RegExp(`worktree at ${await realpath(mine)} has branch 3 checked out`),
  );
  assert.equal(await git(mine, 'branch', '--show-current'), '3');
  assert.equal(await revision(mine), head);
  assert.equal(await readFile(join(mine, 'mine.txt'), 'utf8'), 'edited\n');
  assert.equal(await readFile(join(mine, 'untracked.txt'), 'utf8'), 'untracked\n');
  assert.equal(existsSync(join(repo.root, '.claude', 'worktrees', 'next-issue-3')), false);
});

test('a user who starts issue 3 afresh while .claude/worktrees/next-issue-3 holds a stale branch 3 gets the base branch in it', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '.claude', 'worktrees', 'next-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  await commit(old, 'stale.txt');
  await writeFile(join(old, 'scratch.txt'), 'scratch\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(await realpath(path), await realpath(old));
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

test('a user who starts issue 3 gets branch 3 in .claude/worktrees/next-issue-3 under the repository root', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, branchName(3), 'main', 'origin', true);
  assert.equal(path, join(repo.root, '.claude', 'worktrees', 'next-issue-3'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
});

test('a user with a Claude Code worktree at .claude/worktrees/3 keeps it and its edits when issue 3 starts', async () => {
  const { repo } = await clones();
  const mine = join(repo.root, '.claude', 'worktrees', '3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', 'worktree-3', mine, 'origin/main');
  await writeFile(join(mine, 'a.txt'), 'edited\n');
  await writeFile(join(mine, 'untracked.txt'), 'untracked\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(path, join(repo.root, '.claude', 'worktrees', 'next-issue-3'));
  assert.equal(await git(mine, 'branch', '--show-current'), 'worktree-3');
  assert.equal(await readFile(join(mine, 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(await readFile(join(mine, 'untracked.txt'), 'utf8'), 'untracked\n');
});

test('a user whose Claude Code worktree at .claude/worktrees/3 holds branch 3 keeps it when issue 3 resumes', async () => {
  const { repo } = await clones();
  const mine = join(repo.root, '.claude', 'worktrees', '3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', mine, 'origin/main');
  const kept = await commit(mine, 'kept.txt');
  await assert.rejects(
    addWorktree(repo, 3, '3', 'main', 'origin', false),
    new RegExp(`worktree at ${await realpath(mine)} has branch 3 checked out`),
  );
  assert.equal(await revision(mine), kept);
  assert.equal(await findWorktree(repo, '3'), undefined);
  assert.equal(existsSync(join(repo.root, '.claude', 'worktrees', 'next-issue-3')), false);
});

test('a user who resumes issue 3 after its old worktree .worktrees/3 was removed gets the commits of branch 3 in .claude/worktrees/next-issue-3', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '.worktrees', '3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  const kept = await commit(old, 'kept.txt');
  await removeOldWorktrees(repo.root);
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, join(repo.root, '.claude', 'worktrees', 'next-issue-3'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
});

test('a user who resumes issue 3 on a saved branch gets that branch in the worktree', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), 'issue-3');
});

test('a user whose worktree at ../tool-issue-3 holds the saved branch keeps it when issue 3 resumes', async () => {
  const { repo } = await clones();
  const mine = join(repo.root, '..', 'tool-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', 'issue-3', mine, 'origin/main');
  await assert.rejects(
    addWorktree(repo, 3, 'issue-3', 'main', 'origin', false),
    new RegExp(`worktree at ${await realpath(mine)} has branch issue-3 checked out`),
  );
  assert.equal(await git(mine, 'branch', '--show-current'), 'issue-3');
  assert.equal(await findWorktree(repo, 'issue-3'), undefined);
});

test('a user whose worktree at .claude/worktrees/next-issue-5 holds branch 3 keeps it when issue 3 resumes', async () => {
  const { repo } = await clones();
  const mine = join(repo.root, '.claude', 'worktrees', 'next-issue-5');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', mine, 'origin/main');
  await assert.rejects(
    addWorktree(repo, 3, '3', 'main', 'origin', false),
    new RegExp(`worktree at ${await realpath(mine)} has branch 3 checked out`),
  );
  assert.equal(await git(mine, 'branch', '--show-current'), '3');
  assert.equal(await findWorktree(repo, '3'), undefined);
});

test('a user who resumes issue 3 while .claude/worktrees/next-issue-3 is left detached gets branch 3 back in it', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(first, 'config', 'user.name', 't');
  await git(first, 'config', 'user.email', 't@t');
  const kept = await commit(first, 'kept.txt');
  await git(first, 'checkout', '-q', '--detach', 'origin/main');
  await writeFile(join(first, 'stray.txt'), 'x\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, first);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
});

test('a user who resumes issue 3 while the hunt worktree holds branch 3 gets the work in .claude/worktrees/next-issue-3', async () => {
  const { repo } = await clones();
  const hunt = await huntWorktree(repo, 'main', 'origin');
  await git(hunt, 'checkout', '-q', '-b', '3');
  const kept = await commit(hunt, 'kept.txt');
  assert.equal(await findWorktree(repo, '3'), undefined);
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, join(repo.root, '.claude', 'worktrees', 'next-issue-3'));
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
  assert.equal(await git(hunt, 'branch', '--show-current'), '');
});

test('a user whose main worktree holds branch 3 with changes keeps them when issue 3 starts', async () => {
  const { repo } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  const head = await commit(repo.root, 'mine.txt');
  await writeFile(join(repo.root, 'mine.txt'), 'edited\n');
  await writeFile(join(repo.root, 'untracked.txt'), 'untracked\n');
  await assert.rejects(addWorktree(repo, 3, '3', 'main', 'origin', true), /main worktree/);
  assert.equal(await git(repo.root, 'branch', '--show-current'), '3');
  assert.equal(await revision(repo.root), head);
  assert.equal(await readFile(join(repo.root, 'mine.txt'), 'utf8'), 'edited\n');
  assert.equal(existsSync(join(repo.root, 'untracked.txt')), true);
  assert.equal(existsSync(join(repo.root, '.claude', 'worktrees', 'next-issue-3')), false);
});

test('a user whose main worktree holds branch 3 never gets it as the worktree of a resumed issue 3', async () => {
  const { repo } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  await writeFile(join(repo.root, 'untracked.txt'), 'untracked\n');
  await assert.rejects(addWorktree(repo, 3, '3', 'main', 'origin', false), /main worktree/);
  assert.equal(await git(repo.root, 'branch', '--show-current'), '3');
  assert.equal(existsSync(join(repo.root, 'untracked.txt')), true);
});

test('a user whose issue ends while the main worktree holds its branch keeps the main worktree', async () => {
  const { repo } = await clones();
  await git(repo.root, 'checkout', '-q', '-b', '3');
  assert.equal(await findWorktree(repo, '3'), undefined);
});

test('a user whose issue ends gets the worktree that holds its branch removed', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '.claude', 'worktrees', 'next-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  const path = await findWorktree(repo, '3');
  assert.notEqual(path, undefined);
  assert.equal(await removeWorktree(repo, path!), true);
  assert.equal(existsSync(old), false);
  assert.equal(await findWorktree(repo, '3'), undefined);
});

test('the worker reports a base that it cannot fast-forward for the worktree', async () => {
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
