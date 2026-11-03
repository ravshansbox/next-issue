import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Repo } from '../src/git.mts';
import {
  dropState,
  type IssueState,
  readState,
  resetState,
  STATE_DIR,
  writeState,
} from '../src/state.mts';

async function repo(): Promise<Repo> {
  return { owner: 'acme', name: 'tool', root: await mkdtemp(join(tmpdir(), 'next-issue-')) };
}

const STATE: IssueState = {
  issue: 7,
  phase: 'review',
  branch: 'issue-7',
  pr: 12,
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
  const path = join(target.root, STATE_DIR, '7.json');
  await writeFile(
    path,
    `{ ${VALID}, "phase": "review", "reviewLog": [{ "round": 1, "fingerprint": "a b", "findings": "- a b" }] }`,
  );
  assert.deepEqual((await readState(target, 7))?.reviewLog, [
    { round: 1, fingerprint: 'a b', findings: '- a b' },
  ]);
});

test('a missing state gives undefined', async () => {
  assert.equal(await readState(await repo(), 7), undefined);
});

test('a caller that reads a broken state gets an error that names the file', async () => {
  const target = await repo();
  await writeState(target, STATE);
  const path = join(target.root, STATE_DIR, '7.json');
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
  `{ ${VALID}, "phase": "review", "pr": "12", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "title": 1, "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "commitFixes": "1", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "baseFix": { "sha": "a" }, "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "reviewLog": [null] }`,
  `{ ${VALID}, "phase": "review", "handedOver": "yes", "reviewLog": [] }`,
  `{ ${VALID}, "phase": "review", "reviewLog": [{ "round": 1, "findings": "x", "dispute": 2 }] }`,
]) {
  test(`a caller that reads a state file holding ${text} gets an error that names the file`, async () => {
    const target = await repo();
    await writeState(target, STATE);
    const path = join(target.root, STATE_DIR, '7.json');
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
