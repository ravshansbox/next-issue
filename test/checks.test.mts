import assert from "node:assert/strict";
import { test } from "node:test";
import { type CheckState, type ChecksProbe, type Clock, pollChecks } from "../src/github.mts";

const OPTIONS = { intervalSeconds: 10, graceMs: 60_000, timeoutMs: 300_000 };

function clock(): Clock & { time: number } {
  const fake = {
    time: 0,
    now: () => fake.time,
    sleep: async (ms: number) => {
      fake.time += ms;
    },
  };
  return fake;
}

function probe(list: Array<"none" | "some">, watch: CheckState[]): ChecksProbe & { polls: number } {
  const state = {
    polls: 0,
    list: async () => {
      const next = list[Math.min(state.polls, list.length - 1)]!;
      state.polls += 1;
      return next;
    },
    watch: async () => watch.shift() ?? "pass",
  };
  return state;
}

test("a build that passes gives pass", async () => {
  assert.equal(await pollChecks(probe(["some"], ["pass"]), OPTIONS, clock()), "pass");
});

test("a build that fails gives fail", async () => {
  assert.equal(await pollChecks(probe(["some"], ["fail"]), OPTIONS, clock()), "fail");
});

test("a pending build waits and asks again", async () => {
  const target = probe(["some"], ["pending", "pending", "pass"]);
  const time = clock();
  assert.equal(await pollChecks(target, OPTIONS, time), "pass");
  assert.equal(target.polls, 3);
  assert.equal(time.time, 20_000);
});

test("a check that starts late is not read as no check", async () => {
  const target = probe(["none", "none", "some"], ["pass"]);
  const time = clock();
  assert.equal(await pollChecks(target, OPTIONS, time), "pass");
  assert.equal(target.polls, 3);
  assert.equal(time.time, 20_000);
});

test("no check after the grace time gives none", async () => {
  const target = probe(["none"], []);
  const time = clock();
  assert.equal(await pollChecks(target, OPTIONS, time), "none");
  assert.equal(target.polls, 7);
  assert.equal(time.time, 60_000);
});

test("a grace time of zero gives none at once", async () => {
  const target = probe(["none"], []);
  assert.equal(await pollChecks(target, { ...OPTIONS, graceMs: 0 }, clock()), "none");
  assert.equal(target.polls, 1);
});

test("the deadline stops the wait", async () => {
  const time = clock();
  const target: ChecksProbe = { list: async () => "some", watch: async () => "pending" };
  assert.equal(await pollChecks(target, OPTIONS, time), "timeout");
  assert.equal(time.time, OPTIONS.timeoutMs);
});

test("the watch gets only the time that is left", async () => {
  const seen: number[] = [];
  const target: ChecksProbe = {
    list: async () => "some",
    watch: async (timeoutMs) => {
      seen.push(timeoutMs);
      return "pending";
    },
  };
  assert.equal(await pollChecks(target, { ...OPTIONS, timeoutMs: 25_000 }, clock()), "timeout");
  assert.deepEqual(seen, [25_000, 15_000, 5_000]);
});

test("a timeout from the watch is passed on", async () => {
  assert.equal(await pollChecks(probe(["some"], ["timeout"]), OPTIONS, clock()), "timeout");
});
