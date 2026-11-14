import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Repo } from '../src/git.mts';
import {
  dropState,
  type IssueState,
  readState,
  resetState,
  savedIssues,
  stateDir,
  writeState,
} from '../src/state.mts';
import { tempDir } from './temp-dir.mts';

async function repo(): Promise<Repo> {
  return { owner: 'acme', name: 'tool', root: await tempDir() };
}

const STATE: IssueState = {
  issue: 7,
  phase: 'review',
  branch: 'issue-7',
  ciFixes: 1,
  reviewRounds: 2,
  reviewLog: [{ round: 1, findings: '- a b' }],
};

test('the state survives the round trip', async () => {
  const target = await repo();
  await writeState(target, STATE);
  assert.deepEqual(await readState(target, 7), STATE);
});

test('a caller that reads a state file of an earlier version with a fingerprint gets the state back', async () => {
  const target = await repo();
  await writeState(target, STATE);
  const path = join(stateDir(target.root), '7.json');
  await writeFile(
    path,
    `{ ${VALID}, "phase": "review", "reviewLog": [{ "round": 1, "fingerprint": "a b", "findings": "- a b" }] }`,
  );
  assert.deepEqual((await readState(target, 7))?.reviewLog, [
    { round: 1, fingerprint: 'a b', findings: '- a b' },
  ]);
});

test('a write of the state that fails part-way leaves the earlier state file readable and unchanged', async (t) => {
  const target = await repo();
  await writeState(target, STATE);
  const path = join(stateDir(target.root), '7.json');
  const before = await readFile(path, 'utf8');
  const realWriteFile = fsPromises.writeFile;
  t.mock.method(fsPromises, 'writeFile', async (file: string, data: string) => {
    await realWriteFile(file, data.slice(0, 5));
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(writeState(target, { ...STATE, ciFixes: 2 }), { message: 'ENOSPC' });
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readState(target, 7), STATE);
  assert.deepEqual(await readdir(stateDir(target.root)), ['7.json']);
});

test('a completed write of the state leaves only the state file, and savedIssues lists only the issue', async () => {
  const target = await repo();
  await writeState(target, STATE);
  await writeState(target, { ...STATE, ciFixes: 2 });
  assert.deepEqual(await readdir(stateDir(target.root)), ['7.json']);
  assert.equal((await readState(target, 7))?.ciFixes, 2);
  assert.deepEqual(await savedIssues(target), [7]);
});

test('a missing state gives undefined', async () => {
  assert.equal(await readState(await repo(), 7), undefined);
});

test('a caller that reads a broken state gets an error that names the file', async () => {
  const target = await repo();
  await writeState(target, STATE);
  const path = join(stateDir(target.root), '7.json');
  await writeFile(path, '{ "issue": 7');
  await assert.rejects(readState(target, 7), {
    message: `the state file ${path} is not valid JSON`,
  });
});

const VALID = '"issue": 7, "branch": "issue-7", "ciFixes": 0, "reviewRounds": 0';
for (const text of [
  'null',
  '{}',
  '{ "issue": 7, "phase": "review" }',
  `{ ${VALID}, "phase": "done", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "title": 1, "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "implementerReply": 1, "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "fixerReply": 1, "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "commitFixes": "1", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "landed": [1], "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "reviewLog": [null] }`,
  `{ ${VALID}, "phase": "review", "handedOver": "yes", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "reviewLog": [{ "round": 1, "findings": "x", "dispute": 2 }] }`,
]) {
  test(`a caller that reads a state file holding ${text} gets an error that names the file`, async () => {
    const target = await repo();
    await writeState(target, STATE);
    const path = join(stateDir(target.root), '7.json');
    await writeFile(path, text);
    await assert.rejects(readState(target, 7), {
      message: `the state file ${path} does not hold a valid state`,
    });
  });
}

test('resetState clears the hand-over mark', () => {
  assert.equal(resetState({ ...STATE, handedOver: true }).handedOver, undefined);
});

test('resetState drops the budgets and keeps the resume point', () => {
  assert.deepEqual(resetState(STATE), {
    ...STATE,
    ciFixes: 0,
    commitFixes: 0,
    reviewRounds: 0,
    reviewLog: [],
  });
});

test('dropState takes the state away and accepts a state that is not there', async () => {
  const target = await repo();
  await writeState(target, STATE);
  await dropState(target, 7);
  assert.equal(await readState(target, 7), undefined);
  await dropState(target, 7);
});
