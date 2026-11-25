import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { Repo } from '../src/shared/git.mts';
import { clones, git } from './clones.mts';
import { baseGh } from './fake-gh.mts';

await baseGh();

const SETUP = new URL('../src/shared/setup.mts', import.meta.url).href;

const READ_BASE = `const { basePackage } = await import(${JSON.stringify(SETUP)});
const { base, text } = await basePackage(JSON.parse(process.argv[1]), 'origin');
process.stdout.write(base + ' ' + (text !== undefined));`;

async function holdRefLocks(root: string): Promise<void> {
  const hooks = await git(root, 'rev-parse', '--git-path', 'hooks');
  await writeFile(
    join(root, hooks, 'reference-transaction'),
    '#!/bin/sh\nif [ "$1" = prepared ]; then sleep 1; fi\n',
    { mode: 0o755 },
  );
}

function readBase(repo: Repo): Promise<{ stdout: string }> {
  return promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    READ_BASE,
    JSON.stringify(repo),
  ]);
}

test('two processes that check the package.json of the base at the same time both read it from origin/main and leave no ref behind', async () => {
  const { repo, other } = await clones();
  await writeFile(join(other, 'package.json'), '{}\n');
  await git(other, 'add', 'package.json');
  await git(other, 'commit', '-q', '-m', 'package');
  await git(other, 'push', '-q', 'origin', 'main');
  await holdRefLocks(repo.root);
  const results = await Promise.all([readBase(repo), readBase(repo)]);
  assert.deepEqual(
    results.map((result) => result.stdout),
    ['origin/main true', 'origin/main true'],
  );
  assert.equal(await git(repo.root, 'for-each-ref', 'refs/next-issue'), '');
});
