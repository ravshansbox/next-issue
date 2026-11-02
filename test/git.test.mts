import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { must } from "../src/exec.mts";
import {
  addWorktree,
  branchName,
  discardChanges,
  ensureIgnored,
  findWorktree,
  isDirty,
  parseRemote,
  push,
  removeWorktree,
  type Repo,
  revision,
  setAside,
} from "../src/git.mts";

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
  await git(other, "checkout", "-q", "-b", "3");
  const pushed = await commit(other, "b.txt");
  await git(other, "push", "-q", "origin", "3");
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  assert.equal(await revision(path), pushed);
});

test("addWorktree fast-forwards a local branch that the remote left behind", async () => {
  const { repo, other } = await clones();
  await git(repo.root, "branch", "3", "main");
  await git(other, "checkout", "-q", "-b", "3");
  const pushed = await commit(other, "b.txt");
  await git(other, "push", "-q", "origin", "3");
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  assert.equal(await revision(path), pushed);
});

test("addWorktree starts a new branch from the base", async () => {
  const { repo } = await clones();
  const { path, baseUpdated } = await addWorktree(repo, 3, "3", "main", "origin");
  assert.equal(await revision(path), await revision(repo.root));
  assert.equal(baseUpdated, true);
});

test("a user who starts issue 3 gets branch 3 in .worktrees/3 under the repository root", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, branchName(3), "main", "origin");
  assert.equal(path, join(repo.root, ".worktrees", "3"));
  assert.equal(await git(path, "branch", "--show-current"), "3");
});

test("a user who resumes issue 3 on a saved branch gets that branch in the worktree", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "issue-3", "main", "origin");
  assert.equal(await git(path, "branch", "--show-current"), "issue-3");
});

test("a user who resumes issue 3 while its old worktree holds the saved branch works in that worktree", async () => {
  const { repo } = await clones();
  const old = join(repo.root, "..", "tool-issue-3");
  await git(repo.root, "worktree", "add", "-q", "-b", "issue-3", old, "origin/main");
  const { path } = await addWorktree(repo, 3, "issue-3", "main", "origin");
  assert.equal(path, await findWorktree(repo, "issue-3"));
  assert.equal(await git(path, "branch", "--show-current"), "issue-3");
  assert.equal(existsSync(join(repo.root, ".worktrees", "3")), false);
});

test("a user whose issue ends gets the worktree that holds its branch removed", async () => {
  const { repo } = await clones();
  const old = join(repo.root, "..", "tool-issue-3");
  await git(repo.root, "worktree", "add", "-q", "-b", "issue-3", old, "origin/main");
  const path = await findWorktree(repo, "issue-3");
  assert.notEqual(path, undefined);
  assert.equal(await removeWorktree(repo, path!), true);
  assert.equal(existsSync(old), false);
  assert.equal(await findWorktree(repo, "issue-3"), undefined);
});

test("addWorktree reports a base that it cannot fast-forward", async () => {
  const { repo, other } = await clones();
  await commit(repo.root, "local.txt");
  await commit(other, "remote.txt");
  await git(other, "push", "-q", "origin", "main");
  const { path, baseUpdated } = await addWorktree(repo, 3, "3", "main", "origin");
  assert.equal(baseUpdated, false);
  assert.equal(await revision(path), await git(repo.root, "rev-parse", "origin/main"));
});

test("push with force replaces a remote branch that the base reset left behind", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  await commit(path, "old.txt");
  await push(path, "origin", "3");
  await git(path, "reset", "-q", "--hard", "origin/main");
  const fixed = await commit(path, "fix.txt");
  await assert.rejects(push(path, "origin", "3"));
  await push(path, "origin", "3", true);
  assert.equal(await git(repo.root, "ls-remote", "origin", "refs/heads/3"), `${fixed}\trefs/heads/3`);
});

test("discardChanges puts back a tracked file and removes a new one", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  const head = await revision(path);
  await writeFile(join(path, "a.txt"), "the reviewer wrote this\n");
  await writeFile(join(path, "notes.md"), "scratch\n");
  assert.equal(await isDirty(path), true);
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await isDirty(path), false);
  assert.equal(await readFile(join(path, "a.txt"), "utf8"), "a.txt\n");
  assert.equal(existsSync(join(path, "notes.md")), false);
  assert.equal(await revision(path), head);
});

test("discardChanges throws away a change that the index holds", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  const head = await revision(path);
  await writeFile(join(path, "a.txt"), "tampered\n");
  await git(path, "add", "a.txt");
  await writeFile(join(path, "notes.md"), "scratch\n");
  await git(path, "add", "notes.md");
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await isDirty(path), false);
  assert.equal(await readFile(join(path, "a.txt"), "utf8"), "a.txt\n");
  assert.equal(existsSync(join(path, "notes.md")), false);
  assert.equal(await revision(path), head);
});

test("discardChanges undoes a commit that the reviewer made", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  const head = await revision(path);
  await writeFile(join(path, "a.txt"), "the reviewer committed this\n");
  await git(path, "commit", "-q", "-am", "reviewer commit");
  assert.equal(await isDirty(path), false);
  assert.equal(await discardChanges(path, head), true);
  assert.equal(await revision(path), head);
  assert.equal(await readFile(join(path, "a.txt"), "utf8"), "a.txt\n");
});

test("discardChanges keeps an ignored file and reports a clean worktree", async () => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  await writeFile(join(path, ".gitignore"), "deps/\n");
  await git(path, "add", ".gitignore");
  await git(path, "commit", "-q", "-m", "ignore deps");
  await mkdir(join(path, "deps"));
  await writeFile(join(path, "deps", "pkg.txt"), "installed\n");
  assert.equal(await discardChanges(path, await revision(path)), false);
  assert.equal(existsSync(join(path, "deps", "pkg.txt")), true);
});

test("a disputed commit and change move to their own branch and leave the issue branch at the pushed commit", async (t) => {
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const saved = { ...process.env };
  Object.assign(process.env, identity);
  t.after(() => {
    for (const name of Object.keys(identity)) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, "3", "main", "origin");
  const head = await revision(path);
  await commit(path, "b.txt");
  await writeFile(join(path, "c.txt"), "c.txt\n");
  const aside = await setAside(path, "3", head);
  assert.match(aside, /^3-dispute-[0-9a-f]{7}$/);
  assert.equal(await revision(path), head);
  assert.equal(await isDirty(path), false);
  assert.equal(existsSync(join(path, "b.txt")), false);
  assert.equal(await git(path, "show", `${aside}:b.txt`), "b.txt");
  assert.equal(await git(path, "show", `${aside}:c.txt`), "c.txt");
});
