import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const HELPER = new URL('temp-folder.ts', import.meta.url).href;

function folderAfterExit(parent?: string): string {
  const script = `const { tempFolder } = await import(${JSON.stringify(HELPER)}); console.log(await tempFolder(${parent === undefined ? '' : JSON.stringify(parent)}));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  }).trim();
}

test('a temp folder is gone after the test process exits', () => {
  const folder = folderAfterExit();
  assert.ok(folder.length > 0);
  assert.equal(existsSync(folder), false);
});

test('a temp folder made in a given parent is gone after the test process exits', () => {
  const folder = folderAfterExit('/tmp');
  assert.ok(folder.startsWith('/tmp/'));
  assert.equal(existsSync(folder), false);
});
