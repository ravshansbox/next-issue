import assert from "node:assert/strict";
import { test } from "node:test";
import { labelArgs } from "../src/github.mts";

const MANAGED = ["status:todo", "status:in-progress", "status:in-review", "status:done"];

test("labelArgs adds the new label", () => {
  assert.deepEqual(labelArgs("status:in-review", MANAGED, []), ["--add-label", "status:in-review"]);
});

test("labelArgs removes only a label that is present", () => {
  assert.deepEqual(labelArgs("status:in-review", MANAGED, ["status:todo", "type: bug"]), [
    "--add-label",
    "status:in-review",
    "--remove-label",
    "status:todo",
  ]);
});

test("labelArgs never removes the label it adds", () => {
  assert.deepEqual(labelArgs("status:done", MANAGED, ["status:done", "status:in-review"]), [
    "--add-label",
    "status:done",
    "--remove-label",
    "status:in-review",
  ]);
});
