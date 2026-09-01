import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Config, CONFIG_FILE, loadConfig, managedLabels, writeDefaultConfig } from "../src/config.mts";

async function parse(value: unknown): Promise<Config> {
  return loadConfig(await root(JSON.stringify(value)));
}

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
  assert.equal(config.draftPullRequest, true);
  assert.equal(config.agentTimeoutMinutes, 30);
  assert.equal(config.commandTimeoutMinutes, 10);
  assert.equal(config.diffMaxChars, 60000);
  assert.deepEqual(config.models, {});
});

test("the file merges into the defaults", async () => {
  const config = await loadConfig(
    await root(
      JSON.stringify({
        maxCiFixes: 1,
        draftPullRequest: false,
        models: { fixer: "m" },
        labels: { done: "shipped" },
      }),
    ),
  );
  assert.equal(config.maxCiFixes, 1);
  assert.equal(config.draftPullRequest, false);
  assert.equal(config.maxReviewRounds, 3);
  assert.deepEqual(config.models, { fixer: "m" });
  assert.equal(config.labels.done, "shipped");
  assert.equal(config.labels.needsHuman, "status:needs-human");
});

test("a broken file stops the run", async () => {
  await assert.rejects(loadConfig(await root("{ oops")), /is not valid JSON/);
});

test("a field of the wrong type stops the run", async () => {
  await assert.rejects(parse({ maxCiFixes: "3" }), /maxCiFixes must be a whole number of 0 or more/);
  await assert.rejects(parse({ checkIntervalSeconds: 0 }), /checkIntervalSeconds must be a whole number of 1/);
  await assert.rejects(parse({ maxReviewRounds: 1.5 }), /maxReviewRounds must be a whole number of 1/);
  await assert.rejects(parse({ diffMaxChars: 0 }), /diffMaxChars must be a whole number of 1/);
  await assert.rejects(parse({ draftPullRequest: "yes" }), /draftPullRequest must be true or false/);
  await assert.rejects(parse({ remote: "" }), /remote must be text that is not empty/);
  await assert.rejects(parse({ setupCommand: 12 }), /setupCommand must be text that is not empty/);
  await assert.rejects(parse({ labels: "none" }), /labels must be an object/);
  await assert.rejects(parse({ models: { fixer: "" } }), /models.fixer must be text that is not empty/);
});

test("an unknown field stops the run", async () => {
  await assert.rejects(parse({ maxCiFixed: 3 }), /unknown field: maxCiFixed/);
  await assert.rejects(parse({ models: { implementor: "m" } }), /unknown model role: implementor/);
  await assert.rejects(parse({ labels: { blocked: "x" } }), /unknown label name: blocked/);
});

test("a budget of zero and an empty ready label are allowed", async () => {
  const config = await parse({ maxCiFixes: 0, labels: { ready: "" } });
  assert.equal(config.maxCiFixes, 0);
  assert.equal(config.labels.ready, "");
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
