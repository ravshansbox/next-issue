import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../src/github.mts";
import { exitCode, type Loop, runIssues } from "../src/loop.mts";
import type { IssueReport, Outcome } from "../src/pipeline.mts";

function issue(number: number): Issue {
  return { number, title: "t", body: "", createdAt: "2026-01-01T00:00:00Z", labels: [], assignees: [] };
}

function report(number: number, outcome: Outcome): IssueReport {
  return { issue: number, outcome, ciFixes: 0, reviewRounds: 0, ms: 0 };
}

type Fake = Loop & { resets: number[]; processed: number[] };

function loop(outcomes: Record<number, Outcome>, stops: boolean[] = []): Fake {
  const fake: Fake = {
    resets: [],
    processed: [],
    issues: Object.keys(outcomes).map((key) => issue(Number(key))),
    process: async (target) => {
      fake.processed.push(target.number);
      return report(target.number, outcomes[target.number]!);
    },
    reset: async (number) => {
      fake.resets.push(number);
    },
    stop: async () => stops.shift() ?? false,
  };
  return fake;
}

const ARGS = { once: false, reset: false };

test("every issue is handled in order", async () => {
  const fake = loop({ 1: "skipped", 2: "done", 3: "needs-human" });
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 3]);
  assert.deepEqual(result.reports.map((entry) => entry.outcome), ["skipped", "done", "needs-human"]);
  assert.equal(result.stoppedAt, undefined);
});

test("--max counts the handled issues, not the skipped ones", async () => {
  const fake = loop({ 1: "skipped", 2: "done", 3: "done" });
  await runIssues({ ...ARGS, max: 1 }, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test("--once stops after the first handled issue", async () => {
  const fake = loop({ 1: "skipped", 2: "error", 3: "done" });
  await runIssues({ ...ARGS, once: true }, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test("--reset runs before every issue", async () => {
  const fake = loop({ 1: "skipped", 2: "done" });
  await runIssues({ ...ARGS, reset: true }, fake);
  assert.deepEqual(fake.resets, [1, 2]);
});

test("a stop flag ends the run after the current issue", async () => {
  const fake = loop({ 1: "done", 2: "done", 3: "done" }, [false, false, true]);
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(result.stoppedAt, 2);
});

test("a stop flag from an earlier run is dropped at the start", async () => {
  const fake = loop({ 1: "done", 2: "done" }, [true]);
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(result.stoppedAt, undefined);
});

test("the exit code is 1 only when an issue needs a person or failed", () => {
  assert.equal(exitCode([report(1, "done"), report(2, "skipped")]), 0);
  assert.equal(exitCode([report(1, "needs-human")]), 1);
  assert.equal(exitCode([report(1, "error")]), 1);
  assert.equal(exitCode([]), 0);
});
