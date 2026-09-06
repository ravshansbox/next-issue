import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { packageVersion } from "../src/version.mts";

test("the reported version is the one in package.json", async () => {
  const raw = await readFile(join(import.meta.dirname, "..", "package.json"), "utf8");
  const expected = (JSON.parse(raw) as { version: string }).version;
  assert.equal(await packageVersion(), expected);
});
