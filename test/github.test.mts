import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type CommandRecord, setCommandObserver } from "../src/exec.mts";
import { labelArgs, setLabel } from "../src/github.mts";

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

async function fakeGh(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const labels = join(dir, "labels");
  await writeFile(labels, "status:todo\n");
  const script = `#!/bin/sh
case "$1 $2" in
  "label list") echo '[{"name":"status:todo"}]' ;;
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
