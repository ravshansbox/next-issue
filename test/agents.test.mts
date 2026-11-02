import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REVIEWING, runAgent, spawnClaude, toolFields, withStderr } from "../src/agents.mts";
import { Recorder } from "../src/observe.mts";

async function fakeClaude(script: string): Promise<{ recorder: Recorder; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "next-issue-"));
  const executable = join(root, "claude");
  await writeFile(executable, `#!/bin/sh\n${script}\n`);
  await chmod(executable, 0o755);
  return { recorder: await Recorder.create(root, "quiet"), executable };
}

function request(executable: string, timeoutMs?: number) {
  return { name: "coder", cwd: tmpdir(), prompt: "hi", profile: REVIEWING, executable, timeoutMs };
}

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

test("the harness shows the Claude CLI stderr when the Claude CLI process fails", async () => {
  const { recorder, executable } = await fakeClaude("echo 'not logged in' >&2; exit 1");
  await assert.rejects(runAgent(recorder, request(executable)), (error: Error) => {
    assert.match(error.message, /\nClaude CLI stderr:\nnot logged in$/);
    return true;
  });
});

test("the harness shows only the last 2000 characters of the Claude CLI stderr", async () => {
  const { recorder, executable } = await fakeClaude(
    "printf 'x%.0s' $(seq 1 3000) >&2; printf 'end' >&2; exit 1",
  );
  await assert.rejects(runAgent(recorder, request(executable)), (error: Error) => {
    const tail = error.message.split("\nClaude CLI stderr:\n")[1] ?? "";
    assert.equal(tail.length, 2000);
    assert.match(tail, /end$/);
    return true;
  });
});

test("the harness reports a timeout without the Claude CLI stderr when the agent runs too long", async () => {
  const { recorder, executable } = await fakeClaude("echo 'still working' >&2; sleep 5");
  await assert.rejects(runAgent(recorder, request(executable, 200)), {
    message: "The coder agent did not finish in 200 ms.",
  });
});

test("the harness shows Claude CLI stderr that arrives after the Claude CLI process exits", async () => {
  const { recorder, executable } = await fakeClaude(
    "(sleep 0.1; echo 'late detail' >&2) </dev/null >/dev/null & exit 1",
  );
  await assert.rejects(runAgent(recorder, request(executable)), (error: Error) => {
    assert.match(error.message, /\nClaude CLI stderr:\nlate detail$/);
    return true;
  });
});
