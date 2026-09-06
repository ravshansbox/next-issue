import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectSetupCommand } from "../src/setup.mts";

async function project(...files: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "next-issue-"));
  for (const name of files) {
    await writeFile(join(path, name), "");
  }
  return path;
}

test("each lock file gives its install command", async () => {
  const expected: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["Cargo.lock", "cargo fetch"],
    ["go.sum", "go mod download"],
    ["uv.lock", "uv sync"],
    ["poetry.lock", "poetry install"],
    ["Gemfile.lock", "bundle install"],
  ];
  for (const [file, command] of expected) {
    assert.equal(await detectSetupCommand(await project(file)), command);
  }
});

test("a yarn project with .yarnrc.yml gets the immutable flag", async () => {
  assert.equal(
    await detectSetupCommand(await project("yarn.lock", ".yarnrc.yml")),
    "yarn install --immutable",
  );
});

test("pnpm wins when more than one lock file is present", async () => {
  assert.equal(
    await detectSetupCommand(await project("package-lock.json", "pnpm-lock.yaml")),
    "pnpm install --frozen-lockfile",
  );
});

test("a project without a lock file gives no command", async () => {
  assert.equal(await detectSetupCommand(await project("package.json")), undefined);
});

test("a directory that is not there gives no command", async () => {
  assert.equal(await detectSetupCommand(join(tmpdir(), "next-issue-does-not-exist")), undefined);
});
