import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILE, loadConfig } from '../src/config.ts';

function project(content?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-next-issue-config-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, '.pi'));
    fs.writeFileSync(path.join(root, CONFIG_FILE), content);
  }
  return root;
}

test('a project without a config file gets the defaults', async () => {
  const config = await loadConfig(project());
  assert.deepEqual(config, {
    remote: 'origin',
    maxCiFixes: 3,
    maxReviewRounds: 3,
    checkTimeoutMinutes: 30,
    diffMaxChars: 60000,
    logMaxChars: 20000,
  });
});

test('a project config overrides the given fields only', async () => {
  const config = await loadConfig(project(JSON.stringify({ maxReviewRounds: 1, remote: 'up' })));
  assert.equal(config.maxReviewRounds, 1);
  assert.equal(config.remote, 'up');
  assert.equal(config.maxCiFixes, 3);
});

test('a project config with an unknown field is rejected with its name', async () => {
  await assert.rejects(
    loadConfig(project(JSON.stringify({ merge: false }))),
    /unknown field: merge/,
  );
});

test('a project config with a bad number is rejected with the field name', async () => {
  await assert.rejects(
    loadConfig(project(JSON.stringify({ maxReviewRounds: 0 }))),
    /maxReviewRounds must be a whole number of 1 or more/,
  );
});

test('a project config that is not JSON is rejected', async () => {
  await assert.rejects(loadConfig(project('{')), /is not valid JSON/);
});
