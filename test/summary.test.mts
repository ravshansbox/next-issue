import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type RoleTotals } from "../src/observe.mts";
import { formatSummary, type RunSummary } from "../src/summary.mts";

function role(total: number, calls: number): RoleTotals {
  return { ...emptyUsage(), total, calls, ms: 0 };
}

const SUMMARY: RunSummary = {
  runId: "2026-08-24T10-00-00-000Z",
  logFile: ".next-issue/runs/2026-08-24T10-00-00-000Z.jsonl",
  roles: { implementer: role(38_100, 1), reviewer: role(21_500, 3) },
  counts: { "issue.start": 2 },
  total: { ...emptyUsage(), total: 59_600 },
  issues: [
    { issue: 41, outcome: "done", pr: 57, ciFixes: 0, reviewRounds: 2, ms: 72_000 },
    {
      issue: 43,
      outcome: "needs-human",
      reason: "review budget",
      pr: 58,
      ciFixes: 1,
      reviewRounds: 3,
      ms: 245_000,
    },
    { issue: 44, outcome: "skipped", ciFixes: 0, reviewRounds: 0, ms: 0 },
  ],
};

test("formatSummary counts every outcome", () => {
  const lines = formatSummary(SUMMARY).split("\n");
  assert.equal(lines[0], "run 2026-08-24T10-00-00-000Z");
  assert.equal(lines[1], "issues 3: 1 done, 1 needs-human, 0 error, 1 skipped");
});

test("formatSummary drops the empty fields of an issue", () => {
  const lines = formatSummary(SUMMARY).split("\n");
  assert.match(lines[2]!, /#41 done\b.*pr 57 .*reviews 2 .*1m12s$/);
  assert.doesNotMatch(lines[2]!, /ci fixes/);
  assert.match(lines[3]!, /#43 needs-human\b.*ci fixes 1 .*reviews 3 .*4m05s .*\(review budget\)$/);
  assert.equal(lines[4], "  #44 skipped");
});

test("formatSummary shortens the token totals", () => {
  const lines = formatSummary(SUMMARY).split("\n");
  assert.equal(lines[5], "tokens 59.6k (implementer 38.1k in 1, reviewer 21.5k in 3)");
  assert.equal(lines[6], `log ${SUMMARY.logFile}`);
});

test("formatSummary handles a run without issues", () => {
  const empty = formatSummary({ ...SUMMARY, roles: {}, issues: [], total: emptyUsage() });
  assert.equal(empty.split("\n")[1], "issues 0: 0 done, 0 needs-human, 0 error, 0 skipped");
  assert.match(empty, /\ntokens 0\n/);
});
