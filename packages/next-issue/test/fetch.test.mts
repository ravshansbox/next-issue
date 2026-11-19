import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { must } from '../src/shared/exec.mts';
import { pushToBase } from '../src/shared/git-land.mts';
import { startMerge } from '../src/shared/git-merge.mts';
import { addWorktree } from '../src/shared/worktree.mts';
import { clones, commit, git } from './clones.mts';
import { tempDir } from './temp-dir.mts';

async function refuseOverlappingFetches(t: TestContext): Promise<void> {
  const real = await must('sh', ['-c', 'command -v git']);
  const dir = await tempDir();
  const busy = join(dir, 'fetching');
  await writeFile(
    join(dir, 'git'),
    `#!/bin/sh
if [ "$1" = fetch ] || [ "$1" = push ]; then
  mkdir "${busy}" 2>/dev/null || { echo "cannot lock ref: another fetch or push runs" >&2; exit 1; }
  sleep 0.3
  "${real}" "$@"
  code=$?
  rmdir "${busy}"
  exit $code
fi
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
}

test('the worker lands issue 3 while it sets up the worktree of issue 4, and both fetches succeed one after the other', async (t) => {
  const { repo, other } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await git(path, 'config', 'user.name', 't');
  await git(path, 'config', 'user.email', 't@t');
  await commit(path, 'b.txt');
  await commit(other, 'c.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  await refuseOverlappingFetches(t);
  const [merged, added] = await Promise.all([
    startMerge(path, 'main', 'origin'),
    addWorktree(repo, 4, '4', 'main', 'origin', false),
  ]);
  assert.deepEqual(merged.files, []);
  assert.equal(await git(added.path, 'log', '-1', '--format=%s'), 'c.txt');
});

test('the worker pushes issue 3 to main while it sets up the worktree of issue 4, and the push and the fetch both succeed', async (t) => {
  const { repo } = await clones();
  const { path } = await addWorktree(repo, 3, '3', 'main', 'origin', false);
  await commit(path, 'b.txt');
  await refuseOverlappingFetches(t);
  const [landed, added] = await Promise.all([
    pushToBase(path, 'origin', 'main'),
    addWorktree(repo, 4, '4', 'main', 'origin', false),
  ]);
  assert.equal(landed.pushed, true);
  assert.ok(added.path);
});
