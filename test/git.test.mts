import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { must } from "../src/exec.mts";
import { addWorktree, ensureIgnored, parseRemote, type Repo, revision } from "../src/git.mts";

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

function git(cwd: string, ...args: string[]): Promise<string> {
  return must("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

async function commit(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`);
  await git(cwd, "add", name);
  await git(cwd, "commit", "-q", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

async function clones(): Promise<{ repo: Repo; other: string }> {
  const base = await mkdtemp(join(tmpdir(), "next-issue-"));
  const remote = join(base, "remote.git");
  await git(base, "init", "-q", "--bare", "-b", "main", remote);
  const other = join(base, "other");
  await git(base, "clone", "-q", remote, other);
  await git(other, "checkout", "-q", "-B", "main");
  await commit(other, "a.txt");
  await git(other, "push", "-q", "origin", "main");
  const root = join(base, "tool");
  await git(base, "clone", "-q", remote, root);
  return { repo: { owner: "acme", name: "tool", root }, other };
}

test("addWorktree takes a branch that exists only on the remote", async () => {
  const { repo, other } = await clones();
  await git(other, "checkout", "-q", "-b", "issue-3");
  const pushed = await commit(other, "b.txt");
  await git(other, "push", "-q", "origin", "issue-3");
  const path = await addWorktree(repo, 3, "main", "origin");
  assert.equal(await revision(path), pushed);
});

test("addWorktree fast-forwards a local branch that the remote left behind", async () => {
  const { repo, other } = await clones();
  await git(repo.root, "branch", "issue-3", "main");
  await git(other, "checkout", "-q", "-b", "issue-3");
  const pushed = await commit(other, "b.txt");
  await git(other, "push", "-q", "origin", "issue-3");
  const path = await addWorktree(repo, 3, "main", "origin");
  assert.equal(await revision(path), pushed);
});

test("addWorktree starts a new branch from the base", async () => {
  const { repo } = await clones();
  const path = await addWorktree(repo, 3, "main", "origin");
  assert.equal(await revision(path), await revision(repo.root));
});
