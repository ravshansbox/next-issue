import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { must } from '../src/exec.mts';
import {
  abortMerge,
  branchName,
  commitAll,
  commitMerge,
  discardChanges,
  disputeBranches,
  ensureIgnored,
  HookError,
  isAncestor,
  isDirty,
  latestSubject,
  parseRemote,
  push,
  type Repo,
  revision,
  setAside,
  startMerge,
} from '../src/git.mts';
import { addWorktree, findWorktree, removeWorktree } from '../src/worktree.mts';

test('parseRemote reads every remote form', () => {
  const expected = { owner: 'acme', name: 'tool' };
  assert.deepEqual(parseRemote('git@github.com:acme/tool.git'), expected);
  assert.deepEqual(parseRemote('git@github.com:acme/tool'), expected);
  assert.deepEqual(parseRemote('ssh://git@github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('https://github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('http://github.com/acme/tool\n'), expected);
});

test('parseRemote refuses an unknown form', () => {
  assert.throws(() => parseRemote('acme/tool'), /Cannot parse/);
});

async function dir(gitignore?: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'next-issue-'));
  if (gitignore !== undefined) {
    await writeFile(join(path, '.gitignore'), gitignore);
  }
  return path;
}

test('ensureIgnored makes a missing .gitignore', async () => {
  const path = await dir();
  assert.equal(await ensureIgnored(path, '.next-issue/'), true);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), '.next-issue/\n');
});

test('ensureIgnored adds the missing line ending', async () => {
  const path = await dir('node_modules/');
  assert.equal(await ensureIgnored(path, '.next-issue/'), true);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), 'node_modules/\n.next-issue/\n');
});

test('ensureIgnored leaves an entry that is present', async () => {
  const path = await dir('  .next-issue/  \n');
  assert.equal(await ensureIgnored(path, '.next-issue/'), false);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), '  .next-issue/  \n');
});

function git(cwd: string, ...args: string[]): Promise<string> {
  return must('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
}

async function commit(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`);
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-q', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function clones(): Promise<{ repo: Repo; other: string }> {
  const base = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const remote = join(base, 'remote.git');
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const other = join(base, 'other');
  await git(base, 'clone', '-q', remote, other);
  await git(other, 'checkout', '-q', '-B', 'main');
  await commit(other, 'a.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const root = join(base, 'tool');
  await git(base, 'clone', '-q', remote, root);
  return { repo: { owner: 'acme', name: 'tool', root }, other };
}

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
  assert.equal(await commitMerge(path, [], 'chore: merge origin/main'), true);
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
  assert.equal(await commitMerge(path, ['a.txt'], 'chore: merge'), false);
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
  assert.equal(await commitMerge(path, ['a.txt'], 'chore: merge'), false);
  await startMerge(path, 'main', 'origin');
  await writeFile(join(path, 'a.txt'), 'branch and base\n=======\n');
  assert.equal(await commitMerge(path, ['a.txt'], 'chore: merge'), true);
  assert.equal(await git(path, 'rev-parse', 'HEAD^1'), head);
  assert.equal(await readFile(join(path, 'a.txt'), 'utf8'), 'branch and base\n=======\n');
});

test('startMerge reports a branch that already holds the base with no merge to commit', async () => {
  const { path, base } = await diverged();
  await commit(base, 'b.txt');
  await git(base, 'push', '-q', 'origin', 'main');
  await startMerge(path, 'main', 'origin');
  assert.equal(await commitMerge(path, [], 'chore: merge'), true);
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
  await startMerge(path, 'main', 'origin');
  await assert.rejects(commitMerge(path, [], 'chore: merge'), (error) => {
    assert.ok(error instanceof HookError);
    assert.match(error.message, /lint fails/);
    return true;
  });
  await git(path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
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
