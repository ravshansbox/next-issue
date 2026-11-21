import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { pushToBase } from '../src/shared/git-land.mts';
import { PORTS } from '../src/shared/ports.mts';
import { clones, git } from './clones.mts';
import { type Harness, harness } from './harness.mts';
import {
  type Files,
  landedNames as landedFiles,
  pushBase,
  remoteMain,
  useGit,
  writeFiles,
} from './real-git.mts';

const CHECK = 'echo generated > generated.txt; echo changed >> a.txt; test -f fixed.txt';

function scripts(test: string): string {
  return JSON.stringify({ scripts: { format: 'true', lint: 'true', typecheck: 'true', test } });
}

async function checked(
  t: TestContext,
  check: string,
  fix: Files,
): Promise<{ target: Harness; other: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  await pushBase(other, { 'package.json': scripts(check) });
  const target = await harness(t, { root: repo.root });
  useGit(target, (worktree) => writeFiles(worktree, fix));
  target.context.ports.runCheck = PORTS.runCheck;
  return { target, other };
}

test('a user whose check writes files and then passes after a fix gets only the fix and the change pushed to the base', async (t) => {
  const { target, other } = await checked(t, CHECK, { 'fixed.txt': 'fixed\n' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(await landedFiles(other), [
    'a.txt',
    'fixed.txt',
    'implementer.txt',
    'package.json',
  ]);
  assert.equal(await git(other, 'show', 'origin/main:a.txt'), 'a.txt');
});

test('a user whose check writes files and fails, and whose fixer changes nothing, gets the issue handed over with no fix commit after one check fix', async (t) => {
  const { target, other } = await checked(t, CHECK, {});
  const before = await remoteMain(other);
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'no fix commit');
  assert.equal(report.ciFixes, 1);
  assert.equal(await remoteMain(other), before);
});

test('a user whose checks pass after writing files, and whose push the base refuses, gets the change pushed on the next try with no file the check wrote', async (t) => {
  const { target, other } = await checked(
    t,
    'echo generated > generated.txt; echo changed >> a.txt',
    {},
  );
  let pushes = 0;
  target.context.ports.pushToBase = async (cwd, remote, base) => {
    pushes += 1;
    if (pushes === 1) {
      await pushBase(other, { 'moved.txt': 'moved\n' });
    }
    return pushToBase(cwd, remote, base);
  };
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(pushes, 2);
  assert.deepEqual(await landedFiles(other), [
    'a.txt',
    'implementer.txt',
    'moved.txt',
    'package.json',
  ]);
  assert.equal(await git(other, 'show', 'origin/main:a.txt'), 'a.txt');
});

test('a user whose project has a package.json and no lock file gets the change pushed to the base with no package-lock.json', async (t) => {
  const { target, other } = await checked(t, 'true', {});
  target.context.ports.detectSetupCommand = PORTS.detectSetupCommand;
  target.context.ports.runSetup = PORTS.runSetup;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(await landedFiles(other), ['a.txt', 'implementer.txt', 'package.json']);
});
