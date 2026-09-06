import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.mts";
import type { Issue } from "../src/github.mts";
import { skipReason } from "../src/pipeline.mts";

const config = await loadConfig("/does-not-exist");

function issue(labels: string[]): Issue {
  return { number: 1, title: "t", body: "", createdAt: "2026-01-01T00:00:00Z", labels };
}

test("a fresh claim needs the ready label", () => {
  assert.equal(skipReason(issue(["status:todo"]), config, false), undefined);
  assert.equal(skipReason(issue([]), config, false), "not-ready");
});

test("a stop label wins over everything", () => {
  for (const label of ["status:done", "status:needs-human", "status:blocked"]) {
    assert.equal(skipReason(issue(["status:todo", label]), config, false), "stop-label");
    assert.equal(skipReason(issue([label]), config, true), "stop-label");
  }
});

test("work that is already in flight is left alone", () => {
  assert.equal(skipReason(issue(["status:todo", "status:in-progress"]), config, false), "in-flight");
  assert.equal(skipReason(issue(["status:todo", "status:in-review"]), config, false), "in-flight");
});

test("a resume ignores the ready label and the flight labels", () => {
  assert.equal(skipReason(issue(["status:in-progress"]), config, true), undefined);
  assert.equal(skipReason(issue(["status:in-review"]), config, true), undefined);
  assert.equal(skipReason(issue([]), config, true), undefined);
});

test("an empty ready label turns the requirement off", async () => {
  const open = { ...config, labels: { ...config.labels, ready: "" } };
  assert.equal(skipReason(issue([]), open, false), undefined);
  assert.equal(skipReason(issue(["status:in-review"]), open, false), "in-flight");
});
