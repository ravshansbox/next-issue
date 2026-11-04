import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureIgnored } from '../src/gitignore.mts';
import { tempDir } from './temp-dir.mts';

async function dir(gitignore?: string): Promise<string> {
  const path = await tempDir();
  if (gitignore !== undefined) {
    await writeFile(join(path, '.gitignore'), gitignore);
  }
  return path;
}

test('ensureIgnored makes a missing .gitignore', async () => {
  const path = await dir();
  assert.equal(await ensureIgnored(path, '.next-issue/'), true);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), '.next-issue/\n');
});

test('ensureIgnored adds the missing line ending', async () => {
  const path = await dir('node_modules/');
  assert.equal(await ensureIgnored(path, '.next-issue/'), true);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), 'node_modules/\n.next-issue/\n');
});

test('ensureIgnored leaves an entry that is present', async () => {
  const path = await dir('  .next-issue/  \n');
  assert.equal(await ensureIgnored(path, '.next-issue/'), false);
  assert.equal(await readFile(join(path, '.gitignore'), 'utf8'), '  .next-issue/  \n');
});
