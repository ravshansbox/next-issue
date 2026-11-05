import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../src/git.ts';
import { tempFolder } from './temp-folder.ts';

test('a user in a subfolder of a repository gets the root of the repository', async () => {
  const root = fs.realpathSync(tempFolder());
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'sub'));
  assert.equal(await repoRoot(path.join(root, 'sub')), root);
});

test('a user outside a repository gets an error', async () => {
  const folder = tempFolder();
  await assert.rejects(repoRoot(folder), /git rev-parse --show-toplevel failed/);
});
