import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingFindings,
  fingerprint,
  formatVerdict,
  openFindings,
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

test("every finding is open while a review round is left", () => {
  assert.equal(blockingFindings(BLOCKING).length, 1);
  assert.deepEqual(openFindings(BLOCKING, false), BLOCKING.findings);
  const taste: Verdict = {
    verdict: "request_changes",
    summary: "",
    findings: [{ severity: "minor", detail: "taste" }],
  };
  assert.equal(openFindings(taste, false).length, 1);
});

test("the last round leaves a minor finding open no more", () => {
  assert.deepEqual(openFindings(BLOCKING, true), [{ severity: "blocking", detail: "The count is wrong." }]);
  const taste: Verdict = {
    verdict: "request_changes",
    summary: "",
    findings: [{ severity: "minor", detail: "taste" }],
  };
  assert.deepEqual(openFindings(taste, true), []);
  assert.deepEqual(openFindings({ verdict: "approve", summary: "", findings: [] }, true), []);
});

test("a blocking finding beats a verdict of approve", () => {
  const contradictory: Verdict = {
    verdict: "approve",
    summary: "Good enough.",
    findings: [{ severity: "blocking", detail: "The migration drops the table." }],
  };
  const open = openFindings(contradictory, true);
  assert.equal(open.length, 1);
  assert.match(formatVerdict(contradictory, open), /### Review: changes requested/);
});

test("formatVerdict shows the head, the summary and every finding", () => {
  const text = formatVerdict(BLOCKING, BLOCKING.findings);
  assert.match(text, /### Review: changes requested/);
  assert.match(text, /One problem is left\./);
  assert.match(text, /- \*\*blocking\*\* The count is wrong\./);
  assert.match(text, /- \*\*minor\*\* The name is long\./);
  assert.match(formatVerdict({ verdict: "approve", summary: "Good.", findings: [] }, []), /Review: approved/);
});

test("an approval that leaves a finding says why", () => {
  const taste: Verdict = {
    verdict: "request_changes",
    summary: "Taste only.",
    findings: [{ severity: "minor", detail: "The name is long." }],
  };
  const text = formatVerdict(taste, []);
  assert.match(text, /### Review: approved/);
  assert.match(text, /- \*\*minor\*\* The name is long\./);
  assert.match(text, /the review budget is spent/);
  assert.doesNotMatch(formatVerdict(taste, taste.findings), /the review budget is spent/);
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
