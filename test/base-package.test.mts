import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
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

async function holdPackedRefsAfterFetch(root: string): Promise<() => Promise<void>> {
  const hooks = await git(root, 'rev-parse', '--git-path', 'hooks');
  const lock = join(root, await git(root, 'rev-parse', '--git-path', 'packed-refs.lock'));
  await writeFile(
    join(root, hooks, 'reference-transaction'),
    `#!/bin/sh\nif [ "$1" = committed ] && [ ! -e '${lock}.held' ]; then touch '${lock}.held' '${lock}'; fi\n`,
    { mode: 0o755 },
  );
  return async () => {
    while (!existsSync(lock)) {
      await setTimeout(20);
    }
    await setTimeout(2000);
    await rm(lock);
  };
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

test('a process that checks the package.json of the base while another git process holds the packed refs lock for 2 seconds leaves no ref behind', async () => {
  const { repo } = await clones();
  const releaseAfterTwoSeconds = await holdPackedRefsAfterFetch(repo.root);
  await Promise.all([readBase(repo), releaseAfterTwoSeconds()]);
  assert.equal(await git(repo.root, 'for-each-ref', 'refs/next-issue'), '');
});
