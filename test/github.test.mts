import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type CommandRecord, setCommandObserver } from "../src/exec.mts";
import { failedCheckLogs, labelArgs, prNumber, setLabel } from "../src/github.mts";

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

async function fakeChecksGh(t: TestContext, runView: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  const checks =
    '[{"name":"build","bucket":"fail","link":"https://github.com/acme/tool/actions/runs/7","description":"the job failed"}]';
  const script = `#!/bin/sh
case "$1 $2" in
  "pr checks") echo '${checks}' ;;
  "run view") ${runView} ;;
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

test("failedCheckLogs gives the job logs when the read works", async (t) => {
  const dir = await fakeChecksGh(t, 'echo "boom"');
  const report = await failedCheckLogs({ owner: "acme", name: "tool", root: dir }, "issue-1", 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /boom/);
});

test("failedCheckLogs tells the fixer when the log read fails", async (t) => {
  const dir = await fakeChecksGh(t, 'echo "gone" >&2; exit 3');
  const report = await failedCheckLogs({ owner: "acme", name: "tool", root: dir }, "issue-1", 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /The log read failed with code 3\./);
});
