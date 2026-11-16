import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parseArgs } from '../src/args.mts';
import { CONFIG_FILE } from '../src/config-fields.mts';
import { must } from '../src/exec.mts';
import { runRepo } from '../src/run.mts';
import { runsDir } from '../src/state.mts';
import { installGh } from './fake-gh.mts';
import { keysSorted } from './sorted-keys.mts';
import { tempDir } from './temp-dir.mts';

async function repoWithConfig(t: TestContext, config: string): Promise<string> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/sorted.git'], {
    cwd: root,
  });
  await mkdir(join(root, '.next-issue'), { recursive: true });
  await writeFile(join(root, CONFIG_FILE), config);
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  return root;
}

function start(root: string): Promise<number> {
  return runRepo(root, parseArgs(['start']), {
    interrupts: {
      afterIssue: () => false,
      afterRound: () => false,
      sleep: async () => false,
    },
  });
}

test('a user who starts a run with an unsorted config file finds its keys sorted at every level, with the same fields and values', async (t) => {
  const written = {
    remote: 'origin',
    labels: { skip: 'blocked', ready: 'todo' },
    checks: ['npm test', 'npm run lint'],
    ignoredChecks: ['release', 'deploy'],
    models: { reviewer: 'r', fixer: null },
  };
  const root = await repoWithConfig(t, JSON.stringify(written));
  assert.equal(await start(root), 0);
  const text = await readFile(join(root, CONFIG_FILE), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'checks',
    'ignoredChecks',
    'labels',
    'models',
    'remote',
  ]);
  assert.ok(keysSorted(JSON.parse(text)));
  assert.deepEqual(JSON.parse(text), {
    ...written,
    ignoredChecks: ['deploy', 'release'],
  });
  assert.match(text, /\n {2}"checks": \[\n {4}"npm test",\n {4}"npm run lint"\n {2}\],\n/);
});

test('a user who starts a run with a sorted config file finds the file untouched', async (t) => {
  const text =
    '{"ignoredChecks": ["deploy", "release"],   "labels": {"ready": "todo", "skip": "blocked"}}';
  const root = await repoWithConfig(t, text);
  assert.equal(await start(root), 0);
  assert.equal(await readFile(join(root, CONFIG_FILE), 'utf8'), text);
});

test('a user who starts a run with a config file that has an error gets the error and finds the file untouched', async (t) => {
  const text = '{"remote": "origin", "maxCiFixes": -1}';
  const root = await repoWithConfig(t, text);
  await assert.rejects(start(root), /maxCiFixes/);
  assert.equal(await readFile(join(root, CONFIG_FILE), 'utf8'), text);
});

test('a user who starts a run finds the keys of the run summary sorted at every level', async (t) => {
  const root = await repoWithConfig(t, '{}');
  assert.equal(await start(root), 0);
  const files = await readdir(runsDir(root));
  const summaryFile = files.find((name) => name.endsWith('.summary.json'))!;
  const summary = JSON.parse(await readFile(join(runsDir(root), summaryFile), 'utf8'));
  assert.ok(Object.keys(summary).length > 1);
  assert.ok(keysSorted(summary));
});
