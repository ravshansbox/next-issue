import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { dropState, lock, readState, savedIssues, unlock, writeState } from '../src/state.ts';

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-next-issue-state-'));
}

test('a second run cannot take the lock while a live run holds it', async () => {
  const repo = root();
  await lock(repo);
  await assert.rejects(lock(repo), /another run works on this repository \(pid \d+\)/);
  await unlock(repo);
  await lock(repo);
  await unlock(repo);
});

test('a run takes over the lock of a run that is no longer alive', async () => {
  const repo = root();
  fs.mkdirSync(path.join(repo, '.worktrees'));
  fs.writeFileSync(path.join(repo, '.worktrees', 'run.lock'), '99999999\n');
  await lock(repo);
  const pid = fs.readFileSync(path.join(repo, '.worktrees', 'run.lock'), 'utf8').trim();
  assert.equal(pid, String(process.pid));
  await unlock(repo);
});

test('a run does not list its lock file as a saved issue', async () => {
  const repo = root();
  await lock(repo);
  assert.deepEqual(await savedIssues(repo), []);
  await unlock(repo);
});

test('a run that ends leaves alone a lock that another run holds', async () => {
  const repo = root();
  fs.mkdirSync(path.join(repo, '.worktrees'));
  fs.writeFileSync(path.join(repo, '.worktrees', 'run.lock'), '99999999\n');
  await unlock(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.worktrees', 'run.lock'), 'utf8'), '99999999\n');
});

test('a run that takes over a dead lock leaves no stale file behind', async () => {
  const repo = root();
  fs.mkdirSync(path.join(repo, '.worktrees'));
  fs.writeFileSync(path.join(repo, '.worktrees', 'run.lock'), '99999999\n');
  await lock(repo);
  assert.deepEqual(fs.readdirSync(path.join(repo, '.worktrees')), ['run.lock']);
  await unlock(repo);
  assert.deepEqual(fs.readdirSync(path.join(repo, '.worktrees')), []);
});

test('a second run that finds the lock held leaves no file of its own behind', async () => {
  const repo = root();
  await lock(repo);
  await assert.rejects(lock(repo), /another run works on this repository/);
  assert.deepEqual(fs.readdirSync(path.join(repo, '.worktrees')), ['run.lock']);
  await unlock(repo);
});

test('a run reads back the state it saved for an issue', async () => {
  const repo = root();
  const state = {
    issue: 4,
    branch: '4',
    phase: 'checks' as const,
    pr: 9,
    ciFixes: 1,
    round: 0,
    earlier: ['first'],
  };
  await writeState(repo, state);
  assert.deepEqual(await readState(repo, 4), state);
});

test('a run finds no state for an issue it never saved', async () => {
  assert.equal(await readState(root(), 4), undefined);
});

test('a run reports a state file it cannot read', async () => {
  const repo = root();
  fs.mkdirSync(path.join(repo, '.worktrees'));
  fs.writeFileSync(path.join(repo, '.worktrees', '4.json'), '{not json');
  await assert.rejects(readState(repo, 4), /the state of #4 cannot be read/);
});

test('a run lists each saved issue and forgets a dropped one', async () => {
  const repo = root();
  const base = { branch: 'b', phase: 'implement' as const, ciFixes: 0, round: 0, earlier: [] };
  await writeState(repo, { ...base, issue: 3 });
  await writeState(repo, { ...base, issue: 12 });
  fs.writeFileSync(path.join(repo, '.worktrees', 'notes.txt'), '');
  assert.deepEqual(
    (await savedIssues(repo)).sort((a, b) => a - b),
    [3, 12],
  );
  await dropState(repo, 3);
  await dropState(repo, 99);
  assert.deepEqual(await savedIssues(repo), [12]);
  assert.equal(await readState(repo, 3), undefined);
});

test('a run finds no saved issue before the state folder exists', async () => {
  assert.deepEqual(await savedIssues(root()), []);
});
