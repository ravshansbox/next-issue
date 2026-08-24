import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.mts";

test("an empty command line gives the defaults", () => {
  const args = parseArgs([]);
  assert.equal(args.command, "run");
  assert.equal(args.level, "normal");
  assert.equal(args.issue, undefined);
  assert.equal(args.max, undefined);
  assert.equal(args.once, false);
});

test("the flags set their fields", () => {
  const args = parseArgs(["--once", "--reset", "--json", "--verbose"]);
  assert.equal(args.once, true);
  assert.equal(args.reset, true);
  assert.equal(args.json, true);
  assert.equal(args.level, "verbose");
});

test("the last level wins", () => {
  assert.equal(parseArgs(["--verbose", "--quiet"]).level, "quiet");
  assert.equal(parseArgs(["--quiet", "--verbose"]).level, "verbose");
});

test("an option with a value eats the next argument", () => {
  const args = parseArgs(["--issue", "7", "--max", "2", "--quiet"]);
  assert.equal(args.issue, 7);
  assert.equal(args.max, 2);
  assert.equal(args.level, "quiet");
});

test("a value that is not a whole number of 1 or more stops the run", () => {
  for (const value of ["0", "-1", "1.5", "two", ""]) {
    assert.throws(() => parseArgs(["--issue", value]), /needs a whole number/);
  }
  assert.throws(() => parseArgs(["--max"]), /needs a whole number/);
});

test("init is a command, and only in the first place", () => {
  assert.equal(parseArgs(["init", "--force"]).command, "init");
  assert.throws(() => parseArgs(["--force", "init"]), /Unknown argument: init/);
  assert.throws(() => parseArgs(["run"]), /Unknown command: run/);
});

test("an unknown option stops the run", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument: --nope/);
});
