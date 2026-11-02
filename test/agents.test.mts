import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { spawnClaude, toolFields, withStderr } from "../src/agents.mts";

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

test("the Claude agent runs in its own process group, so a Ctrl-C in the terminal does not reach it", async () => {
  const child = spawnClaude({
    command: "sh",
    args: ["-c", "ps -o pgid= -p $$"],
    env: process.env,
    signal: new AbortController().signal,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  await once(child, "close");
  assert.equal(Number(output.trim()), child.pid);
});

test("the harness receives what the Claude CLI writes to stderr", async () => {
  let stderr = "";
  const child = spawnClaude(
    {
      command: "sh",
      args: ["-c", "echo 'not logged in' >&2; exit 1"],
      env: process.env,
      signal: new AbortController().signal,
    },
    (chunk) => {
      stderr += chunk;
    },
  );
  child.stdout.resume();
  await once(child, "close");
  assert.equal(stderr, "not logged in\n");
});

test("an agent error shows the Claude CLI stderr tail", () => {
  const original = new Error("Claude Code process exited with code 1");
  const error = withStderr(original, "not logged in\n") as Error;
  assert.equal(error.message, "Claude Code process exited with code 1\nClaude CLI stderr:\nnot logged in");
  assert.equal(error.cause, original);
});

test("an agent error stays the same when the Claude CLI wrote nothing to stderr", () => {
  const original = new Error("Claude Code process exited with code 1");
  assert.equal(withStderr(original, " \n"), original);
});
