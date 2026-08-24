import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.mts";
import type { Issue } from "./github.mts";
import { isClaimable } from "./pipeline.mts";

const config = await loadConfig("/does-not-exist");

function issue(labels: string[], assignees: string[]): Issue {
  return { number: 1, title: "t", body: "", createdAt: "2026-01-01T00:00:00Z", labels, assignees };
}

test("an open issue without an assignee is claimable", () => {
  assert.equal(isClaimable(issue([], []), config, "me"), true);
  assert.equal(isClaimable(issue(["status:todo"], []), config, "me"), true);
});

test("a closing label stops the claim", () => {
  for (const label of ["status:done", "status:needs-human", "status:blocked"]) {
    assert.equal(isClaimable(issue([label], []), config, "me"), false);
  }
});

test("only your own assignment is claimable", () => {
  assert.equal(isClaimable(issue([], ["me"]), config, "me"), true);
  assert.equal(isClaimable(issue([], ["you"]), config, "me"), false);
  assert.equal(isClaimable(issue([], ["me", "you"]), config, "me"), true);
});
