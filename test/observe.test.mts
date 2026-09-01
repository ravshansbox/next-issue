import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addUsage, emptyUsage, type Fields, message, Recorder } from "../src/observe.mts";

async function recorder(): Promise<Recorder> {
  return Recorder.create(await mkdtemp(join(tmpdir(), "next-issue-")), "quiet");
}

async function lines(target: Recorder): Promise<Fields[]> {
  await target.close();
  const raw = await readFile(target.logFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Fields);
}

test("every event goes to the log file with the run id", async () => {
  const target = await recorder();
  target.event("run.start", { repo: "acme/tool" }, "verbose");
  target.event("issues", { open: 2 }, "verbose");
  const records = await lines(target);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.kind, "run.start");
  assert.equal(records[0]!.repo, "acme/tool");
  assert.equal(records[0]!.runId, target.runId);
  assert.equal(typeof records[0]!.ts, "string");
});

test("a scope adds its fields to every event under it", async () => {
  const target = await recorder();
  const issue = target.scope({ issue: 7 });
  const role = issue.scope({ role: "fixer" });
  role.event("agent.start", {}, "verbose");
  target.event("run.end", {}, "verbose");
  const records = await lines(target);
  assert.equal(records[0]!.issue, 7);
  assert.equal(records[0]!.role, "fixer");
  assert.equal(records[1]!.issue, undefined);
});

test("a step writes a start and an end with the time", async () => {
  const target = await recorder();
  const result = await target.step("checks", { pr: 3 }, async () => "pass");
  assert.equal(result, "pass");
  const records = await lines(target);
  assert.deepEqual(
    records.map((record) => record.kind),
    ["checks.start", "checks.end"],
  );
  assert.equal(records[1]!.pr, 3);
  assert.equal(typeof records[1]!.ms, "number");
});

test("a step that throws writes an error event and passes the throw on", async () => {
  const target = await recorder();
  await assert.rejects(
    target.step("push", {}, async () => {
      throw new Error("no remote");
    }),
    /no remote/,
  );
  const records = await lines(target);
  assert.equal(records[1]!.kind, "push.error");
  assert.equal(records[1]!.error, "no remote");
});

test("the summary counts the events and adds the tokens per role", async () => {
  const target = await recorder();
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 };
  target.usage("implementer", usage, 100);
  target.usage("implementer", usage, 50);
  target.usage("reviewer", usage, 20);
  target.event("commit", {}, "verbose");
  const summary = target.summary();
  assert.equal(summary.runId, target.runId);
  assert.equal(summary.roles.implementer!.calls, 2);
  assert.equal(summary.roles.implementer!.total, 36);
  assert.equal(summary.roles.implementer!.ms, 150);
  assert.equal(summary.total.total, 54);
  assert.equal(summary.counts.usage, 3);
  assert.equal(summary.counts.commit, 1);
  await target.close();
});

test("addUsage adds every field", () => {
  const target = emptyUsage();
  addUsage(target, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
  addUsage(target, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
  assert.deepEqual(target, { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
});

test("message reads an error and anything else", () => {
  assert.equal(message(new Error("bad")), "bad");
  assert.equal(message("plain"), "plain");
  assert.equal(message(undefined), "undefined");
});
