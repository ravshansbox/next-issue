import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  abortMerge,
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
  revision,
  setAside,
  startMerge,
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
