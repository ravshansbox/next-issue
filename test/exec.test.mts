import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandRecord, must, run, setCommandObserver } from "../src/exec.mts";

const NODE = process.execPath;

function script(body: string): string[] {
  return ["-e", body];
}

test("run gives the code, the output and the error output", async () => {
  const result = await run(
    NODE,
    script("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
  );
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.timedOut, false);
});

test("run sends the input to the child", async () => {
  const result = await run(NODE, script("process.stdin.pipe(process.stdout)"), { input: "hello" });
  assert.equal(result.stdout, "hello");
  assert.equal(result.code, 0);
});

test("run kills a child that passes the time limit", async () => {
  const result = await run(NODE, script("setTimeout(() => {}, 10000)"), { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("run reports a command that does not exist", async () => {
  await assert.rejects(run("next-issue-no-such-command", []), /ENOENT/);
});

test("the observer sees every command", async () => {
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  try {
    await run(NODE, script("process.exit(0)"), { cwd: process.cwd() });
    await run(NODE, script("process.stderr.write(' bad \\n'); process.exit(2)"));
  } finally {
    setCommandObserver(() => undefined);
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.code, 0);
  assert.equal(seen[0]!.stderr, "");
  assert.equal(seen[0]!.cwd, process.cwd());
  assert.ok(seen[0]!.ms >= 0);
  assert.equal(seen[1]!.code, 2);
  assert.equal(seen[1]!.stderr, "bad");
});

test("must gives the trimmed output and throws on a code that is not zero", async () => {
  assert.equal(await must(NODE, script("process.stdout.write(' text \\n')")), "text");
  await assert.rejects(
    must(NODE, script("process.stderr.write('why'); process.exit(4)")),
    /failed with code 4: why/,
  );
});
