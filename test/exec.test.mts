import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type CommandRecord, must, run, setCommandObserver } from "../src/exec.mts";

const NODE = process.execPath;

function script(body: string): string[] {
  return ["-e", body];
}

async function gone(pid: number): Promise<boolean> {
  for (let left = 40; left > 0; left -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
    await sleep(50);
  }
  process.kill(pid, "SIGKILL");
  return false;
}

async function written(file: string): Promise<number> {
  for (let left = 100; left > 0; left -= 1) {
    const pid = Number(await readFile(file, "utf8").catch(() => "0"));
    if (pid > 0) {
      return pid;
    }
    await sleep(50);
  }
  throw new Error("The child wrote no id.");
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

test("run stops on the time limit even when a grandchild holds the output open", async () => {
  const started = Date.now();
  const result = await run("bash", ["-lc", "sleep 30 & sleep 30"], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test("run kills a grandchild that outlives its parent on the time limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const file = join(dir, "pid");
  try {
    const result = await run("bash", ["-c", `sleep 30 & echo $! > ${file}; sleep 30`], {
      timeoutMs: 1000,
    });
    assert.equal(result.timedOut, true);
    const pid = Number((await readFile(file, "utf8")).trim());
    assert.ok(pid > 0);
    assert.equal(await gone(pid), true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("an interrupt of the harness kills the child and stops the harness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const file = join(dir, "pid");
  const exec = new URL("../src/exec.mts", import.meta.url).href;
  const inner = `import { run } from ${JSON.stringify(exec)}; await run("bash", ["-lc", "echo $$ > ${file}; sleep 30"]);`;
  const harness = spawn(NODE, ["--input-type=module", "-e", inner], { stdio: "ignore" });
  try {
    const pid = await written(file);
    harness.kill("SIGINT");
    assert.deepEqual(await once(harness, "exit"), [null, "SIGINT"]);
    assert.equal(await gone(pid), true);
  } finally {
    harness.kill("SIGKILL");
    await rm(dir, { force: true, recursive: true });
  }
});

test("run keeps only the tail of a long output", async () => {
  const result = await run(NODE, script("process.stdout.write('a'.repeat(100))"), { tailChars: 10 });
  assert.equal(result.stdout, "a".repeat(10));
});

test("run keeps only the tail of a long error output", async () => {
  const result = await run(NODE, script("process.stderr.write('b'.repeat(100))"), { tailChars: 10 });
  assert.equal(result.stderr, "b".repeat(10));
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
  assert.equal(seen[0]!.timedOut, false);
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

test("must reports a child that passes the time limit", async () => {
  await assert.rejects(
    must(NODE, script("setTimeout(() => {}, 10000)"), { timeoutMs: 100 }),
    /did not finish in time/,
  );
});

test("run shows the output of the child on the error stream when asked", async () => {
  const exec = new URL("../src/exec.mts", import.meta.url).href;
  const inner = `import { run } from ${JSON.stringify(exec)}; await run(process.execPath, ["-e", "process.stdout.write('shown')"], { show: true });`;
  const result = await run(NODE, ["--input-type=module", "-e", inner]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "shown");
});
