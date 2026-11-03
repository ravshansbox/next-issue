import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { must } from "../src/exec.mts";

const CLI = fileURLToPath(new URL("../src/cli.mts", import.meta.url));

async function stopCommand(agentDir: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, "stop"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  return stdout;
}

test("a user who runs init gets .next-issue/ and .worktrees/ in .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "next-issue-"));
  await must("git", ["init", "-q"], { cwd: root });
  await must(process.execPath, [CLI, "init"], { cwd: root });
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ".next-issue/\n.worktrees/\n");
});

test("a user who runs --watch with no open issue sees one wait of 1 minute and no summary after Ctrl-C", async () => {
  const root = await mkdtemp(join(tmpdir(), "next-issue-"));
  await must("git", ["init", "-q"], { cwd: root });
  await must("git", ["remote", "add", "origin", "https://github.com/acme/watch.git"], { cwd: root });
  const bin = await mkdtemp(join(tmpdir(), "next-issue-"));
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, "gh"), script, { mode: 0o755 });
  const child = spawn(process.execPath, [CLI, "--watch"], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  while (!stderr.includes("watch.wait")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  child.kill("SIGINT");
  assert.equal(await exited, 0);
  assert.deepEqual(
    stderr.split("\n").filter((line) => line.includes("watch.wait")).map((line) => line.replace(/^\S+ /, "")),
    ["watch.wait minutes=1"],
  );
  assert.match(stderr, /Stopping now\./);
  assert.equal(stdout, "");
});

test("a user who stops the worker with SIGTERM sees it exit and remove its socket and lock files", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const child = spawn(process.execPath, [CLI, "serve"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on("exit", (_code, signal) => resolve(signal)),
  );
  for (let left = 100; left > 0 && !stderr.includes("listening"); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(stderr, /worker listening on .*next-issue\.sock/);
  child.kill("SIGTERM");
  assert.equal(await exited, "SIGTERM");
  assert.deepEqual(await readdir(agentDir), []);
});

test("a user who runs stop sees the worker exit and remove its socket and lock files", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const child = spawn(process.execPath, [CLI, "serve"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on("exit", (_code, signal) => resolve(signal)),
  );
  for (let left = 100; left > 0 && !stderr.includes("listening"); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await stopCommand(agentDir), `next-issue: stopped the worker with process id ${child.pid}\n`);
  assert.equal(await exited, "SIGTERM");
  assert.deepEqual(await readdir(agentDir), []);
});

test("a user who runs stop with no worker alive sees that none is running", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "next-issue-"));
  assert.equal(await stopCommand(agentDir), "next-issue: no worker is running\n");
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => dead.on("exit", resolve));
  await writeFile(join(agentDir, "next-issue.lock"), `${dead.pid}\n`);
  assert.equal(await stopCommand(agentDir), "next-issue: no worker is running\n");
});
