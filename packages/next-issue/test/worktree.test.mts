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

test('a user whose repository has a tag 3 on the base keeps the unpushed commit of local branch 3 on a kept branch when issue 3 starts afresh', async () => {
  const { repo } = await clones();
  await git(repo.root, 'tag', '3', 'main');
  await git(repo.root, 'checkout', '-q', '-b', '3');
  const unpushed = await commit(repo.root, 'unpushed.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  await addWorktree(repo, 3, '3', 'main', 'origin', true);
  assert.equal(
    await git(repo.root, 'rev-parse', `refs/heads/3-kept-${unpushed.slice(0, 7)}`),
    unpushed,
  );
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

test('a user whose repository has a tag 3 on the base resumes issue 3 and gets the unpushed commit of local branch 3 in the worktree', async () => {
  const { repo } = await clones();
  await git(repo.root, 'tag', '3', 'main');
  await git(repo.root, 'checkout', '-q', '-b', '3');
  const unpushed = await commit(repo.root, 'unpushed.txt');
  await git(repo.root, 'checkout', '-q', 'main');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await revision(path), unpushed);
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
  assert.equal(await findWorktree(repo, 3, '3'), undefined);
  assert.equal(existsSync(join(repo.root, '.claude', 'worktrees', 'next-issue-3')), false);
});

test('a user whose issue 3 branch is still in an old .worktrees/3 gets the resume refused with a message that names that worktree, and keeps its commits', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '.worktrees', '3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  const kept = await commit(old, 'kept.txt');
  await assert.rejects(
    addWorktree(repo, 3, '3', 'main', 'origin', false),
    new RegExp(`worktree at ${await realpath(old)} has branch 3 checked out`),
  );
  assert.equal(await revision(old), kept);
});

test('a user who resumes issue 3 on a saved branch gets that branch in the worktree', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), 'issue-3');
});

test('a user who resumes issue 3 on a saved branch issue-3 twice gets the same worktree, and it is removed when the issue ends', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  const { path: resumed } = await addWorktree(repo, 3, 'issue-3', 'main', 'origin', false);
  assert.equal(await realpath(resumed), await realpath(path));
  const found = await findWorktree(repo, 3, 'issue-3');
  assert.equal(await realpath(found!), await realpath(path));
  assert.equal(await removeWorktree(repo, found!), true);
  assert.equal(existsSync(path), false);
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
  assert.equal(await findWorktree(repo, 3, 'issue-3'), undefined);
});

for (const folder of [join('.worktrees', 'fix'), join('.claude', 'worktrees', 'next-issue-5')]) {
  test(`a user whose worktree at ${folder} holds branch 3 keeps it when issue 3 resumes`, async () => {
    const { repo } = await clones();
    const mine = join(repo.root, folder);
    await git(repo.root, 'worktree', 'add', '-q', '-b', '3', mine, 'origin/main');
    await assert.rejects(
      addWorktree(repo, 3, '3', 'main', 'origin', false),
      new RegExp(`worktree at ${await realpath(mine)} has branch 3 checked out`),
    );
    assert.equal(await git(mine, 'branch', '--show-current'), '3');
    assert.equal(await findWorktree(repo, 3, '3'), undefined);
  });
}

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
  const aside = await git(
    repo.root,
    'branch',
    '--list',
    '3-detached-*',
    '--format=%(refname:short)',
  );
  assert.match(aside, /^3-detached-[0-9a-f]{7}$/);
  assert.equal(await git(repo.root, 'show', `${aside}:stray.txt`), 'x');
});

test('a user who resumes issue 3 while .claude/worktrees/next-issue-3 holds a commit on a detached HEAD keeps that commit on a 3-detached branch', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(first, 'config', 'user.name', 't');
  await git(first, 'config', 'user.email', 't@t');
  await git(first, 'checkout', '-q', '--detach', 'origin/main');
  const detached = await commit(first, 'detached.txt');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  const aside = await git(
    repo.root,
    'branch',
    '--list',
    '3-detached-*',
    '--format=%(refname:short)',
  );
  assert.equal(aside, `3-detached-${detached.slice(0, 7)}`);
  assert.equal(await git(repo.root, 'rev-parse', aside), detached);
});

test('a user who resumes issue 3 while .claude/worktrees/next-issue-3 is left clean on a detached HEAD that origin/main holds gets no 3-detached branch', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(first, 'checkout', '-q', '--detach', 'origin/main');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await git(repo.root, 'branch', '--list', '3-detached-*'), '');
});

test('a user who resumes issue 3 while .claude/worktrees/next-issue-3 is left on another branch keeps its edits on a 3-detached branch', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(first, 'config', 'user.name', 't');
  await git(first, 'config', 'user.email', 't@t');
  const kept = await commit(first, 'kept.txt');
  await git(first, 'checkout', '-q', '-b', 'scratch', 'origin/main');
  const scratch = await revision(first);
  await writeFile(join(first, 'a.txt'), 'edited\n');
  await writeFile(join(first, 'stray.txt'), 'x\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(path, first);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
  const aside = await git(
    repo.root,
    'branch',
    '--list',
    '3-detached-*',
    '--format=%(refname:short)',
  );
  assert.match(aside, /^3-detached-[0-9a-f]{7}$/);
  assert.equal(await git(repo.root, 'show', `${aside}:a.txt`), 'edited');
  assert.equal(await git(repo.root, 'show', `${aside}:stray.txt`), 'x');
  assert.equal(await git(repo.root, 'rev-parse', 'scratch'), scratch);
});

test('a user who resumes issue 3 while .claude/worktrees/next-issue-3 is left mid-merge on another branch keeps its edits on a 3-detached branch', async () => {
  const { repo } = await clones();
  const { path: first } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(first, 'config', 'user.name', 't');
  await git(first, 'config', 'user.email', 't@t');
  const kept = await commit(first, 'kept.txt');
  await git(first, 'checkout', '-q', '-b', 'theirs', 'origin/main');
  await writeFile(join(first, 'a.txt'), 'theirs\n');
  await git(first, 'commit', '-q', '-am', 'theirs');
  await git(first, 'checkout', '-q', '-b', 'scratch', 'origin/main');
  await writeFile(join(first, 'a.txt'), 'ours\n');
  await git(first, 'commit', '-q', '-am', 'ours');
  const scratch = await revision(first);
  await git(first, 'merge', '-q', 'theirs').catch(() => '');
  await writeFile(join(first, 'stray.txt'), 'x\n');
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  assert.equal(await git(path, 'branch', '--show-current'), '3');
  assert.equal(await revision(path), kept);
  const aside = await git(
    repo.root,
    'branch',
    '--list',
    '3-detached-*',
    '--format=%(refname:short)',
  );
  assert.match(aside, /^3-detached-[0-9a-f]{7}$/);
  assert.match(await git(repo.root, 'show', `${aside}:a.txt`), /ours/);
  assert.equal(await git(repo.root, 'show', `${aside}:stray.txt`), 'x');
  assert.equal(await git(repo.root, 'rev-parse', 'scratch'), scratch);
});

test('a user who resumes issue 3 while the hunt worktree holds branch 3 gets the work in .claude/worktrees/next-issue-3', async () => {
  const { repo } = await clones();
  const hunt = await huntWorktree(repo, 'main', 'origin');
  await git(hunt, 'checkout', '-q', '-b', '3');
  const kept = await commit(hunt, 'kept.txt');
  assert.equal(await findWorktree(repo, 3, '3'), undefined);
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
  assert.equal(await findWorktree(repo, 3, '3'), undefined);
});

test('a user whose issue ends gets the worktree that holds its branch removed', async () => {
  const { repo } = await clones();
  const old = join(repo.root, '.claude', 'worktrees', 'next-issue-3');
  await git(repo.root, 'worktree', 'add', '-q', '-b', '3', old, 'origin/main');
  const path = await findWorktree(repo, 3, '3');
  assert.notEqual(path, undefined);
  assert.equal(await removeWorktree(repo, path!), true);
  assert.equal(existsSync(old), false);
  assert.equal(await findWorktree(repo, 3, '3'), undefined);
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
