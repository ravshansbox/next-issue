import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.mts";
import type { Issue } from "../src/github.mts";
import { skipReason } from "../src/pipeline.mts";

const config = await loadConfig("/does-not-exist");

function issue(labels: string[], assignees: string[] = []): Issue {
  return { number: 1, title: "t", body: "", createdAt: "2026-01-01T00:00:00Z", labels, assignees };
}

test("a fresh claim needs the ready label", () => {
  assert.equal(skipReason(issue(["status:todo"]), config, "me", false), undefined);
  assert.equal(skipReason(issue([]), config, "me", false), "not-ready");
});

test("a stop label wins over everything", () => {
  for (const label of ["status:done", "status:needs-human", "status:blocked"]) {
    assert.equal(skipReason(issue(["status:todo", label]), config, "me", false), "stop-label");
    assert.equal(skipReason(issue([label]), config, "me", true), "stop-label");
  }
});

test("work that is already in flight is left alone", () => {
  assert.equal(skipReason(issue(["status:todo", "status:in-progress"]), config, "me", false), "in-flight");
  assert.equal(skipReason(issue(["status:todo", "status:in-review"]), config, "me", false), "in-flight");
});

test("a fresh claim needs an issue that nobody holds", () => {
  assert.equal(skipReason(issue(["status:todo"], ["me"]), config, "me", false), "assigned");
  assert.equal(skipReason(issue(["status:todo"], ["you"]), config, "me", false), "assigned");
});

test("a resume ignores the ready label and the flight labels", () => {
  assert.equal(skipReason(issue(["status:in-progress"], ["me"]), config, "me", true), undefined);
  assert.equal(skipReason(issue(["status:in-review"], ["me"]), config, "me", true), undefined);
  assert.equal(skipReason(issue([]), config, "me", true), undefined);
});

test("a resume stops when another person took the issue", () => {
  assert.equal(skipReason(issue(["status:in-progress"], ["you"]), config, "me", true), "assigned");
  assert.equal(skipReason(issue(["status:in-progress"], ["me", "you"]), config, "me", true), "assigned");
});

test("an empty ready label turns the requirement off", async () => {
  const open = { ...config, labels: { ...config.labels, ready: "" } };
  assert.equal(skipReason(issue([]), open, "me", false), undefined);
  assert.equal(skipReason(issue(["status:in-review"]), open, "me", false), "in-flight");
});
