import assert from "node:assert/strict";
import { test } from "node:test";
import { toolFields } from "../src/agents.mts";

test("a bash call logs its command", () => {
  assert.deepEqual(toolFields("Bash", { command: "npm test" }), {
    tool: "Bash",
    command: "npm test",
  });
});

test("another tool logs only its name", () => {
  assert.deepEqual(toolFields("Read", { file_path: "/a" }), { tool: "Read" });
});

test("a bash call without a command logs only its name", () => {
  for (const input of [undefined, null, {}, { command: 3 }]) {
    assert.deepEqual(toolFields("Bash", input), { tool: "Bash" });
  }
});
