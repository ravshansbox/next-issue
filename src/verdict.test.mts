import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingFindings,
  fingerprint,
  formatFindings,
  formatVerdict,
  isApproved,
  readVerdict,
  type Verdict,
} from "./verdict.mts";

const BLOCKING: Verdict = {
  verdict: "request_changes",
  summary: "One problem is left.",
  findings: [
    { severity: "blocking", detail: "The count is wrong." },
    { severity: "minor", detail: "The name is long." },
  ],
};

test("readVerdict refuses a value without findings", () => {
  assert.equal(readVerdict(undefined), undefined);
  assert.equal(readVerdict({ summary: "x" }), undefined);
  assert.equal(readVerdict({ findings: [] }), undefined);
  assert.notEqual(readVerdict(BLOCKING), undefined);
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

test("formatFindings lists the details", () => {
  assert.equal(formatFindings(blockingFindings(BLOCKING)), "- The count is wrong.");
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
