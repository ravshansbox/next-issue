import assert from "node:assert/strict";
import { test } from "node:test";
import { toolFields } from "../src/agents.mts";

test("a Bash call records the command", () => {
  assert.deepEqual(toolFields("Bash", { command: "npm test" }), {
    tool: "Bash",
    command: "npm test",
  });
});

test("a tool that is not Bash records only its name", () => {
  assert.deepEqual(toolFields("Read", { file_path: "/tmp/a.mts" }), { tool: "Read" });
});

test("a Bash call without command text records only its name", () => {
  assert.deepEqual(toolFields("Bash", {}), { tool: "Bash" });
  assert.deepEqual(toolFields("Bash", { command: 12 }), { tool: "Bash" });
  assert.deepEqual(toolFields("Bash", null), { tool: "Bash" });
  assert.deepEqual(toolFields("Bash", "npm test"), { tool: "Bash" });
});
