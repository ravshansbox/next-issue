import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_FILE, loadConfig, managedLabels, writeDefaultConfig } from "./config.mts";

async function root(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-issue-"));
  if (content !== undefined) {
    await writeFile(join(dir, CONFIG_FILE), content);
  }
  return dir;
}

test("a missing file gives the defaults", async () => {
  const config = await loadConfig(await root());
  assert.equal(config.remote, "origin");
  assert.equal(config.maxCiFixes, 3);
  assert.deepEqual(config.models, {});
});

test("the file merges into the defaults", async () => {
  const config = await loadConfig(
    await root(JSON.stringify({ maxCiFixes: 1, models: { fixer: "m" }, labels: { done: "shipped" } })),
  );
  assert.equal(config.maxCiFixes, 1);
  assert.equal(config.maxReviewRounds, 3);
  assert.deepEqual(config.models, { fixer: "m" });
  assert.equal(config.labels.done, "shipped");
  assert.equal(config.labels.needsHuman, "status:needs-human");
});

test("a broken file stops the run", async () => {
  await assert.rejects(loadConfig(await root("{ oops")), /is not valid JSON/);
});

test("managedLabels holds every label the harness sets", async () => {
  const config = await loadConfig(await root());
  assert.deepEqual(managedLabels(config), [
    "status:todo",
    "status:in-progress",
    "status:in-review",
    "status:done",
    "status:needs-human",
  ]);
});

test("writeDefaultConfig writes a file that gives the defaults", async () => {
  const dir = await root();
  const path = await writeDefaultConfig(dir, false);
  assert.equal(path, join(dir, CONFIG_FILE));
  assert.deepEqual(await loadConfig(dir), await loadConfig(await root()));
  assert.match(await readFile(path, "utf8"), /\n$/);
});

test("writeDefaultConfig keeps an existing file without force", async () => {
  const dir = await root('{ "maxCiFixes": 9 }');
  await assert.rejects(writeDefaultConfig(dir, false), /exists already/);
  assert.equal((await loadConfig(dir)).maxCiFixes, 9);
  await writeDefaultConfig(dir, true);
  assert.equal((await loadConfig(dir)).maxCiFixes, 3);
});
