import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { must } from '../src/shared/exec.mts';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PACKAGE, 'dist');

test('a maintainer who runs npm run build gets a dist without files from older builds', async () => {
  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, 'stale.mjs'), '');
  await must('npm', ['run', 'build'], { cwd: PACKAGE });
  await assert.rejects(access(join(DIST, 'stale.mjs')), { code: 'ENOENT' });
  await access(join(DIST, 'cli.mjs'));
});
