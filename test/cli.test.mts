import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { must } from "../src/exec.mts";

const CLI = fileURLToPath(new URL("../src/cli.mts", import.meta.url));

test("a user who runs init gets .next-issue/ and .worktrees/ in .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "next-issue-"));
  await must("git", ["init", "-q"], { cwd: root });
  await must(process.execPath, [CLI, "init"], { cwd: root });
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ".next-issue/\n.worktrees/\n");
});
