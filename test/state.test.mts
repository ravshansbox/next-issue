import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Repo } from "../src/git.mts";
import { dropState, type IssueState, readState, resetState, STATE_DIR, takeStop, writeState } from "../src/state.mts";

async function repo(): Promise<Repo> {
  return { owner: "acme", name: "tool", root: await mkdtemp(join(tmpdir(), "next-issue-")) };
}

const STATE: IssueState = {
  issue: 7,
  phase: "review",
  branch: "issue-7",
  pr: 12,
  ciFixes: 1,
  reviewRounds: 2,
  reviewLog: [{ round: 1, fingerprint: "a b", findings: "- a b" }],
};

test("the state survives the round trip", async () => {
  const target = await repo();
  await writeState(target, STATE);
  assert.deepEqual(await readState(target, 7), STATE);
});

test("a missing state gives undefined", async () => {
  assert.equal(await readState(await repo(), 7), undefined);
});

test("a broken state gives undefined instead of a throw", async () => {
  const target = await repo();
  await writeState(target, STATE);
  await writeFile(join(target.root, STATE_DIR, "7.json"), '{ "issue": 7');
  assert.equal(await readState(target, 7), undefined);
});

test("resetState drops the budgets and the hand-over, and keeps the resume point", async () => {
  const target = await repo();
  await writeState(target, { ...STATE, handedOver: true });
  assert.equal(await resetState(target, 7), true);
  assert.deepEqual(await readState(target, 7), {
    ...STATE,
    ciFixes: 0,
    reviewRounds: 0,
    reviewLog: [],
  });
});

test("resetState reports a state that is not there", async () => {
  assert.equal(await resetState(await repo(), 7), false);
});

test("takeStop reports the flag once and then takes it away", async () => {
  const target = await repo();
  assert.equal(await takeStop(target), false);
  await writeState(target, STATE);
  await writeFile(join(target.root, STATE_DIR, "stop"), "");
  assert.equal(await takeStop(target), true);
  assert.equal(await takeStop(target), false);
});

test("dropState takes the state away and accepts a state that is not there", async () => {
  const target = await repo();
  await writeState(target, STATE);
  await dropState(target, 7);
  assert.equal(await readState(target, 7), undefined);
  await dropState(target, 7);
});
