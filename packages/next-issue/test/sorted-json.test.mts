import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { CONFIG_FILE } from '../src/shared/config-fields.mts';
import { must } from '../src/shared/exec.mts';
import { runRepo } from '../src/worker/run.mts';
import { runsDir } from '../src/shared/state.mts';
import { installGh } from './fake-gh.mts';
import { keysSorted } from './sorted-keys.mts';
import { tempDir } from './temp-dir.mts';
import { writeScripts, serveBase } from './helpers.mts';

async function repoWithConfig(t: TestContext, config: string): Promise<string> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await writeScripts(root, ['format', 'lint', 'typecheck', 'test']);
  await must('git', ['remote', 'add', 'origin', 'git@github.com:acme/sorted.git'], {
    cwd: root,
  });
  await serveBase(root);
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
  return runRepo(root, parseArgs(['start', '--watch', 'off']), {
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
    ignoredChecks: ['release', 'deploy'],
    models: { reviewer: 'r', fixer: null },
  };
  const root = await repoWithConfig(t, JSON.stringify(written));
  assert.equal(await start(root), 0);
  const text = await readFile(join(root, CONFIG_FILE), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['ignoredChecks', 'labels', 'models', 'remote']);
  assert.ok(keysSorted(JSON.parse(text)));
  assert.deepEqual(JSON.parse(text), {
    ...written,
    ignoredChecks: ['deploy', 'release'],
  });
  assert.match(text, /\n {2}"ignoredChecks": \[\n {4}"deploy",\n {4}"release"\n {2}\],\n/);
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
