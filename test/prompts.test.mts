import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../src/github.mts";
import { capDiff, fixPrompt, parseCommitSubject, parseUnrelated } from "../src/prompts.mts";

const ISSUE: Issue = {
  number: 7,
  title: "Add a flag",
  body: "Please add it.",
  createdAt: "2026-01-01T00:00:00Z",
  labels: [],
  assignees: [],
};

const FALLBACK = "fix: fallback";

test("parseCommitSubject reads the last line of the agent text", () => {
  assert.equal(parseCommitSubject("Done.\ncommit: feat: add a flag", FALLBACK), "feat: add a flag");
});

test("parseCommitSubject accepts other letter cases and spaces", () => {
  assert.equal(parseCommitSubject("Commit:   fix: trim", FALLBACK), "fix: trim");
});

test("parseCommitSubject falls back without a line", () => {
  assert.equal(parseCommitSubject("No subject here", FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject("commit:   ", FALLBACK), FALLBACK);
  assert.equal(parseCommitSubject("", FALLBACK), FALLBACK);
});

test("capDiff keeps a diff that fits", () => {
  assert.equal(capDiff("abc", 3), "abc");
  assert.equal(capDiff("", 10), "");
});

test("capDiff cuts a diff that is too long and says so", () => {
  const text = capDiff("abcdef", 3);
  assert.match(text, /^abc\n/);
  assert.match(text, /cut here, after 3 characters\./);
});

test("parseUnrelated reads the marker line", () => {
  assert.equal(parseUnrelated("looked at it\nunrelated: the spec fails on main too"), "the spec fails on main too");
  assert.equal(parseUnrelated("UNRELATED:   spaced  "), "spaced");
});

test("parseUnrelated gives undefined without the marker", () => {
  assert.equal(parseUnrelated("commit: fix: the thing"), undefined);
  assert.equal(parseUnrelated("unrelated:   "), undefined);
  assert.equal(parseUnrelated(""), undefined);
});

test("only the check fixer is offered the unrelated exit", () => {
  const checks = fixPrompt(ISSUE, "The continuous integration checks failed.", "the logs", [], "checks");
  const review = fixPrompt(ISSUE, "The reviewer requested changes.", "the findings", [], "review");
  assert.match(checks, /unrelated: /);
  assert.doesNotMatch(review, /unrelated: /);
});
