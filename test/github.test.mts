import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type CommandRecord, setCommandObserver } from "../src/exec.mts";
import { labelArgs, prNumber, setLabel } from "../src/github.mts";

const MANAGED = ["status:todo", "status:in-progress", "status:in-review", "status:done"];

test("labelArgs adds the new label", () => {
  assert.deepEqual(labelArgs("status:in-review", MANAGED, []), ["--add-label", "status:in-review"]);
});

test("labelArgs removes only a label that is present", () => {
  assert.deepEqual(labelArgs("status:in-review", MANAGED, ["status:todo", "type: bug"]), [
    "--add-label",
    "status:in-review",
    "--remove-label",
    "status:todo",
  ]);
});

test("labelArgs never removes the label it adds", () => {
  assert.deepEqual(labelArgs("status:done", MANAGED, ["status:done", "status:in-review"]), [
    "--add-label",
    "status:done",
    "--remove-label",
    "status:in-review",
  ]);
});

async function fakeGh(t: TestContext, listed = '[{"name":"status:todo"}]'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const labels = join(dir, "labels");
  await writeFile(labels, "status:todo\n");
  const script = `#!/bin/sh
case "$1 $2" in
  "label list") echo '${listed}' ;;
  "label create")
    if grep -qx -- "$3" "${labels}"; then echo "label with name $3 already exists" >&2; exit 1; fi
    echo "$3" >> "${labels}" ;;
  "issue view"|"pr view") echo '{"labels":[]}' ;;
  "issue edit"|"pr edit") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, "gh"), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

test("setLabel creates a missing label once and records no failed command", async (t) => {
  const dir = await fakeGh(t);
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: "acme", name: "labels", root: dir };
  await setLabel(repo, "issue", 1, "status:todo", []);
  await setLabel(repo, "issue", 1, "status:new", []);
  await setLabel(repo, "pr", 2, "status:new", []);
  assert.deepEqual(seen.filter((record) => record.code !== 0), []);
  assert.equal(await readFile(join(dir, "labels"), "utf8"), "status:todo\nstatus:new\n");
});

test("setLabel tries the create again when it failed", async (t) => {
  const dir = await fakeGh(t, "[]");
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: "acme", name: "retry", root: dir };
  await setLabel(repo, "issue", 1, "status:todo", []);
  await setLabel(repo, "issue", 1, "status:todo", []);
  const creates = seen.filter((record) => record.args[0] === "label" && record.args[1] === "create");
  assert.equal(creates.length, 2);
});

test("prNumber reads the number from the pull request URL", () => {
  assert.equal(prNumber("https://github.com/acme/tool/pull/42\n"), 42);
  assert.equal(prNumber("https://github.example.com/acme/tool/pull/7"), 7);
  assert.equal(prNumber("no url here"), undefined);
});
