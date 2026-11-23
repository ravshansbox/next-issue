import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostname, hostOf, repoArg } from '../src/shared/gh.mts';
import { commitAll } from '../src/shared/git-commit.mts';
import {
  changedFiles,
  detectRepo,
  discardChanges,
  disputeBranches,
  isDirty,
  latestSubject,
  parseRemote,
  revision,
  setAside,
} from '../src/shared/git.mts';
import { addWorktree } from '../src/shared/worktree.mts';
import { clones, commit, git } from './clones.mts';
import { tempDir } from './temp-dir.mts';

test('the worker reads every remote form', () => {
  const expected = { host: 'github.com', owner: 'acme', name: 'tool' };
  assert.deepEqual(parseRemote('git@github.com:acme/tool.git'), expected);
  assert.deepEqual(parseRemote('git@github.com:acme/tool'), expected);
  assert.deepEqual(parseRemote('ssh://git@github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('https://github.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('http://github.com/acme/tool\n'), expected);
});

test('the worker keeps the host of a GitHub Enterprise remote in every form', () => {
  const expected = { host: 'github.example.com', owner: 'acme', name: 'tool' };
  assert.deepEqual(parseRemote('git@github.example.com:acme/tool.git'), expected);
  assert.deepEqual(parseRemote('ssh://git@GitHub.Example.com:2222/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('https://user@github.example.com/acme/tool.git'), expected);
  assert.deepEqual(parseRemote('https://github.example.com:8443/acme/tool'), expected);
  assert.deepEqual(parseRemote('acme@acme.ghe.com:acme/tool.git'), {
    host: 'acme.ghe.com',
    owner: 'acme',
    name: 'tool',
  });
});

test('a user whose remote names an ssh host alias gets the real host of that alias', async (t) => {
  const { repo } = await clones();
  await git(repo.root, 'remote', 'add', 'work', 'git@github-work:acme/tool.git');
  const bin = await tempDir();
  await writeFile(
    join(bin, 'ssh'),
    '#!/bin/sh\n[ "$1 $2 $3" = "-G -- github-work" ] || exit 1\necho "user git"\necho "hostname github.example.com"\n',
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const detected = await detectRepo(repo.root, 'work');
  assert.equal(detected.host, 'github.example.com');
});

test('a user whose remote uses the ssh.github.com endpoint on port 443 gets gh calls on github.com', () => {
  for (const url of [
    'ssh://git@ssh.github.com:443/acme/tool.git',
    'git@ssh.github.com:acme/tool.git',
    'ssh://git@SSH.GitHub.com:443/acme/tool',
  ]) {
    const repo = { ...parseRemote(url), root: '/tmp' };
    assert.equal(repoArg(repo), 'acme/tool', url);
    assert.deepEqual(hostname(repo), [], url);
    assert.equal(hostOf(repo), 'github.com', url);
  }
});

test('a user whose ssh alias resolves to ssh.github.com gets gh calls on github.com', async (t) => {
  const { repo } = await clones();
  await git(repo.root, 'remote', 'add', 'work', 'git@gh-443:acme/tool.git');
  const bin = await tempDir();
  await writeFile(
    join(bin, 'ssh'),
    '#!/bin/sh\n[ "$1 $2 $3" = "-G -- gh-443" ] || exit 1\necho "user git"\necho "hostname ssh.github.com"\necho "port 443"\n',
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const detected = await detectRepo(repo.root, 'work');
  assert.equal(repoArg(detected), 'acme/tool');
  assert.deepEqual(hostname(detected), []);
});

test('the worker refuses a remote of an unknown form', () => {
  assert.throws(() => parseRemote('acme/tool'), /Cannot parse/);
});

test('the worker gets the subject of the newest commit ahead of the base, and nothing on a branch that is not ahead', async () => {
  const { repo } = await clones();
  assert.equal(await latestSubject(repo.root, 'main', 'origin'), undefined);
  await commit(repo.root, 'b.txt');
  await commit(repo.root, 'c.txt');
  assert.equal(await latestSubject(repo.root, 'main', 'origin'), 'c.txt');
});

test('the worker puts back a tracked file and removes a new one when it discards changes', async () => {
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

test('the worker throws away a change that the index holds when it discards changes', async () => {
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

test('the worker undoes a commit that the reviewer made when it discards changes', async () => {
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

test('the worker ends a merge whose resolution matches HEAD when it discards changes, so a later merge can start', async () => {
  const { repo, other } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'a.txt'), 'branch\n');
  await git(path, 'commit', '-q', '-am', 'branch');
  await writeFile(join(other, 'a.txt'), 'base\n');
  await git(other, 'commit', '-q', '-am', 'base');
  await git(other, 'push', '-q', 'origin', 'main');
  await git(path, 'fetch', '-q', 'origin');
  await git(path, 'merge', '--no-ff', '--no-commit', 'origin/main').catch(() => undefined);
  await git(path, 'checkout', 'HEAD', '--', 'a.txt');
  const head = await revision(path);
  assert.equal(await discardChanges(path, head, '3'), true);
  await assert.rejects(git(path, 'rev-parse', '--quiet', '--verify', 'MERGE_HEAD'));
});

test('the worker moves a commit of the fixer to another branch and leaves nothing for a later commit to sweep up', async () => {
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

test('the worker commits the tracked and untracked edits the fixer left, so a later checkout cannot lose them', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  const head = await revision(path);
  await writeFile(join(path, 'a.txt'), 'the fixer left this\n');
  await writeFile(join(path, 'new.txt'), 'a new file\n');
  assert.equal(await commitAll(path, 'the edits of the fixer', { hooks: false }), true);
  assert.equal(await isDirty(path), false);
  assert.equal(await git(path, 'rev-parse', 'HEAD~1'), head);
  assert.equal(await git(path, 'show', 'HEAD:new.txt'), 'a new file');
  assert.equal(await git(path, 'show', 'HEAD:a.txt'), 'the fixer left this');
  assert.equal(await commitAll(path, 'nothing left', { hooks: false }), false);
});

test('a user whose git config hides untracked files still gets a new file of the reviewer thrown away', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'status.showUntrackedFiles', 'no');
  const head = await revision(path);
  await writeFile(join(path, 'scratch.test.mts'), 'scratch\n');
  assert.equal(await discardChanges(path, head), true);
  assert.equal(existsSync(join(path, 'scratch.test.mts')), false);
});

test('a user whose git config hides untracked files gets an implementer change that only adds a new file committed', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'status.showUntrackedFiles', 'no');
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'new.txt'), 'a new file\n');
  assert.equal(await commitAll(path, 'feat: add a new file'), true);
  assert.equal(await git(path, 'show', 'HEAD:new.txt'), 'a new file');
});

test('a user whose git config hides untracked files still gets a new file of a disputing fixer saved', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'status.showUntrackedFiles', 'no');
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await writeFile(join(path, 'new.txt'), 'a new file\n');
  assert.equal(await commitAll(path, 'the edits of the fixer', { hooks: false }), true);
  assert.equal(await git(path, 'show', 'HEAD:new.txt'), 'a new file');
});

test('the worker lists the dispute branches of one issue only', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'branch', '3-dispute-1');
  await git(path, 'branch', '3-dispute-2');
  await git(path, 'branch', '30-dispute-1');
  assert.deepEqual(await disputeBranches(repo, '3'), ['3-dispute-1', '3-dispute-2']);
});

test('the worker keeps an ignored file when it discards changes and reports a clean worktree', async () => {
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

test('a run of issue 3 after a crash left its worktree on a detached HEAD with uncommitted files keeps those files on a 3-detached branch', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await commit(path, 'implementer.txt');
  await git(path, 'checkout', '-q', '--detach');
  await writeFile(join(path, 'implementer.txt'), 'unsaved\n');
  await writeFile(join(path, 'new.txt'), 'new\n');
  await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const [aside] = (
    await git(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/3-detached-*')
  ).split('\n');
  assert.ok(aside);
  assert.equal(await git(repo.root, 'show', `${aside}:implementer.txt`), 'unsaved');
  assert.equal(await git(repo.root, 'show', `${aside}:new.txt`), 'new');
});

test('the worker lists the files that landed commits added or changed and leaves out deleted ones', async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  const added = await commit(path, 'b.txt');
  await git(path, 'rm', '-q', 'a.txt');
  await git(path, 'commit', '-q', '-m', 'drop a');
  const dropped = await git(path, 'rev-parse', 'HEAD');
  assert.deepEqual(await changedFiles(path, [added, dropped]), ['b.txt']);
  assert.deepEqual(await changedFiles(path, []), []);
});
