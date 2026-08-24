import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureIgnored, parseRemote } from "../src/git.mts";

test("parseRemote reads every remote form", () => {
  const expected = { owner: "acme", name: "tool" };
  assert.deepEqual(parseRemote("git@github.com:acme/tool.git"), expected);
  assert.deepEqual(parseRemote("git@github.com:acme/tool"), expected);
  assert.deepEqual(parseRemote("ssh://git@github.com/acme/tool.git"), expected);
  assert.deepEqual(parseRemote("https://github.com/acme/tool.git"), expected);
  assert.deepEqual(parseRemote("http://github.com/acme/tool\n"), expected);
});

test("parseRemote refuses an unknown form", () => {
  assert.throws(() => parseRemote("acme/tool"), /Cannot parse/);
});

async function dir(gitignore?: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "next-issue-"));
  if (gitignore !== undefined) {
    await writeFile(join(path, ".gitignore"), gitignore);
  }
  return path;
}

test("ensureIgnored makes a missing .gitignore", async () => {
  const path = await dir();
  assert.equal(await ensureIgnored(path, ".next-issue/"), true);
  assert.equal(await readFile(join(path, ".gitignore"), "utf8"), ".next-issue/\n");
});

test("ensureIgnored adds the missing line ending", async () => {
  const path = await dir("node_modules/");
  assert.equal(await ensureIgnored(path, ".next-issue/"), true);
  assert.equal(await readFile(join(path, ".gitignore"), "utf8"), "node_modules/\n.next-issue/\n");
});

test("ensureIgnored leaves an entry that is present", async () => {
  const path = await dir("  .next-issue/  \n");
  assert.equal(await ensureIgnored(path, ".next-issue/"), false);
  assert.equal(await readFile(join(path, ".gitignore"), "utf8"), "  .next-issue/  \n");
});
