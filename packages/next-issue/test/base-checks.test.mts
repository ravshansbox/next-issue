import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { failedBaseLogs, rerunFailedBase, waitForBaseChecks } from '../src/base-checks.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

async function fakeRunsGh(
  t: TestContext,
  runs: unknown[],
  rerunRuns: unknown[] = runs,
): Promise<string> {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$1 $2" in
  "run list") [ "$3 $4" = "--commit abc" ] || { echo "unexpected: $*" >&2; exit 1; }; if [ -f "$(dirname "$0")/reruns" ]; then echo '${JSON.stringify(rerunRuns)}'; else echo '${JSON.stringify(runs)}'; fi ;;
  "run view") echo "boom in $3" ;;
  "run rerun") [ "$4" = "--failed" ] || { echo "unexpected: $*" >&2; exit 1; }; echo "$3" >> "$(dirname "$0")/reruns" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

const BASE_WAIT = { intervalSeconds: 1, graceMs: 0, timeoutMs: 10_000 };

test('waitForBaseChecks passes when every run on the commit ends without a failure, a cancelled one included', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' },
    { databaseId: 2, name: 'Deploy', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 3, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'pass',
  );
});

test('waitForBaseChecks fails as soon as one run on the commit fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Deploy', status: 'in_progress', conclusion: '' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks reports none when the commit starts no run', async (t) => {
  const dir = await fakeRunsGh(t, []);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'none',
  );
});

test('rerunFailedBase reruns the failed jobs of the failed runs on the commit only and returns once they restart', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure', attempt: 1 },
      { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success', attempt: 1 },
    ],
    [
      { databaseId: 1, name: 'CI', status: 'queued', conclusion: '', attempt: 2 },
      { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success', attempt: 1 },
    ],
  );
  const runs = await rerunFailedBase({ owner: 'acme', name: 'tool', root: dir }, 'abc');
  assert.deepEqual(runs, ['1']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '1\n');
});

test('failedBaseLogs gives the logs of the failed runs on the commit only', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]);
  const report = await failedBaseLogs({ owner: 'acme', name: 'tool', root: dir }, 'abc', 1000);
  assert.match(report, /## CI/);
  assert.match(report, /boom in 1/);
  assert.doesNotMatch(report, /Docs|boom in 2/);
});
