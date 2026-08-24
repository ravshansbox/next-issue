import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, parseRemote, worktreePath } from "./git.mts";

test("parseRemote reads every remote form", () => {
  const expected = { owner: "acme", name: "tool" };
  assert.deepEqual(parseRemote("git@github.com:acme/tool.git"), expected);
  assert.deepEqual(parseRemote("git@github.com:acme/tool"), expected);
  assert.deepEqual(parseRemote("ssh://git@github.com/acme/tool.git"), expected);
  assert.deepEqual(parseRemote("https://github.com/acme/tool.git"), expected);
  assert.deepEqual(parseRemote("http://github.com/acme/tool\n"), expected);
});

test("parseRemote refuses an unknown form", () => {
  assert.throws(() => parseRemote("acme/tool"), /Cannot parse/);
});

test("the branch and the worktree follow the issue number", () => {
  assert.equal(branchName(7), "issue-7");
  assert.equal(worktreePath({ owner: "acme", name: "tool", root: "/work/tool" }, 7), "/work/tool-issue-7");
});
