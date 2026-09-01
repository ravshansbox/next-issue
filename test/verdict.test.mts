import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingFindings,
  fingerprint,
  formatVerdict,
  isApproved,
  readVerdict,
  type Verdict,
} from "../src/verdict.mts";

const BLOCKING: Verdict = {
  verdict: "request_changes",
  summary: "One problem is left.",
  findings: [
    { severity: "blocking", detail: "The count is wrong." },
    { severity: "minor", detail: "The name is long." },
  ],
};

test("readVerdict refuses a value that is not a verdict", () => {
  assert.equal(readVerdict(undefined), undefined);
  assert.equal(readVerdict("approve"), undefined);
  assert.equal(readVerdict({ summary: "x" }), undefined);
  assert.equal(readVerdict({ findings: [] }), undefined);
  assert.equal(readVerdict({ verdict: "approve", summary: "x" }), undefined);
  assert.equal(readVerdict({ verdict: "ok", summary: "x", findings: [] }), undefined);
  assert.equal(readVerdict({ verdict: "approve", summary: 1, findings: [] }), undefined);
  assert.deepEqual(readVerdict(BLOCKING), BLOCKING);
});

test("readVerdict refuses a finding that is not complete", () => {
  const bad = (findings: unknown[]): unknown => ({ verdict: "request_changes", summary: "x", findings });
  assert.equal(readVerdict(bad([{ detail: "no severity" }])), undefined);
  assert.equal(readVerdict(bad([{ severity: "bad", detail: "wrong severity" }])), undefined);
  assert.equal(readVerdict(bad([{ severity: "blocking" }])), undefined);
  assert.equal(readVerdict(bad(["text"])), undefined);
  assert.equal(readVerdict(bad([null])), undefined);
});

test("readVerdict drops the fields that it does not know", () => {
  assert.deepEqual(
    readVerdict({
      verdict: "approve",
      summary: "Good.",
      findings: [{ severity: "minor", detail: "long name", file: "a.ts" }],
      score: 9,
    }),
    { verdict: "approve", summary: "Good.", findings: [{ severity: "minor", detail: "long name" }] },
  );
});

test("only a blocking finding stops the approval", () => {
  assert.equal(blockingFindings(BLOCKING).length, 1);
  assert.equal(isApproved(BLOCKING), false);
  assert.equal(
    isApproved({ verdict: "request_changes", summary: "", findings: [{ severity: "minor", detail: "taste" }] }),
    true,
  );
  assert.equal(isApproved({ verdict: "approve", summary: "", findings: [] }), true);
});

test("formatVerdict shows the head, the summary and every finding", () => {
  const text = formatVerdict(BLOCKING);
  assert.match(text, /### Review: changes requested/);
  assert.match(text, /One problem is left\./);
  assert.match(text, /- \*\*blocking\*\* The count is wrong\./);
  assert.match(formatVerdict({ verdict: "approve", summary: "Good.", findings: [] }), /Review: approved/);
});

test("the fingerprint ignores the order, the case and the punctuation", () => {
  const first = fingerprint([
    { severity: "blocking", detail: "The count is wrong!" },
    { severity: "blocking", detail: "A test is missing." },
  ]);
  const second = fingerprint([
    { severity: "blocking", detail: "a test is missing" },
    { severity: "blocking", detail: "the  count is wrong" },
  ]);
  assert.equal(first, second);
  assert.notEqual(first, fingerprint([{ severity: "blocking", detail: "Something else." }]));
});
