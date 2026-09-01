import assert from "node:assert/strict";
import { test } from "node:test";
import { capDiff, parseCommitSubject } from "../src/prompts.mts";

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
