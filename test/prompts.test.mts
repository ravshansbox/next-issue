import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommitSubject } from "../src/prompts.mts";

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
