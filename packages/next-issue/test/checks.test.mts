import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { failedCheckLogs, waitForChecks } from '../src/checks.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

async function fakeChecksGh(t: TestContext, runView: string): Promise<string> {
  const dir = await tempDir();
  const checks =
    '[{"name":"build","bucket":"fail","link":"https://github.com/acme/tool/actions/runs/7","description":"the job failed"}]';
  const script = `#!/bin/sh
case "$1 $2" in
  "pr checks") echo '${checks}' ;;
  "run view") ${runView} ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

test('failedCheckLogs gives the job logs when the read works', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "boom"');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /boom/);
});

test('failedCheckLogs tells the fixer when the log read fails', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "gone" >&2; exit 3');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /The log read failed with code 3\. gone/);
});

test('failedCheckLogs keeps the partial logs when the read fails', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "boom"; echo "gone" >&2; exit 3');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /boom\nThe log read failed with code 3\. gone/);
});

async function fakeWatchGh(t: TestContext, bucket: string, watches: number[]): Promise<string> {
  const dir = await tempDir();
  const checks = `[{"name":"build","bucket":"${bucket}","link":"","description":""}]`;
  await writeFile(join(dir, 'watches'), watches.join('\n') + '\n');
  const script = `#!/bin/sh
case "$1 $2 $4" in
  "pr checks --watch")
    code=$(head -n 1 "${join(dir, 'watches')}")
    tail -n +2 "${join(dir, 'watches')}" > "${join(dir, 'rest')}"; mv "${join(dir, 'rest')}" "${join(dir, 'watches')}"
    [ "$code" = 0 ] || echo "error connecting to api.github.com" >&2
    exit "$code" ;;
  "pr checks --json") echo '${checks}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

const PR_WAIT = { intervalSeconds: 0, graceMs: 0, timeoutMs: 10_000, show: false };

test('waitForChecks reports a failure when the watch fails and a check is in the fail bucket', async (t) => {
  const dir = await fakeWatchGh(t, 'fail', [1]);
  assert.equal(await waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT), 'fail');
});

test('waitForChecks retries the watch when gh fails but no check failed', async (t) => {
  const dir = await fakeWatchGh(t, 'pending', [1, 0]);
  assert.equal(await waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT), 'pass');
});

test('waitForChecks throws the gh error when the watch keeps failing and no check failed', async (t) => {
  const dir = await fakeWatchGh(t, 'pending', [1, 1, 1]);
  await assert.rejects(
    waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT),
    /no check failed: error connecting to api\.github\.com/,
  );
});

async function fakePrGh(t: TestContext, pr: number): Promise<string> {
  const dir = await tempDir();
  const checks =
    '[{"name":"build","bucket":"fail","link":"https://github.com/acme/tool/actions/runs/7","description":""}]';
  const script = `#!/bin/sh
case "$1 $2 $3" in
  "pr view ${pr}") echo abc ;;
  "pr checks ${pr}") [ "$4" = "--watch" ] && exit 1; echo '${checks}' ;;
  "run view"*) echo boom ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

test('the worker reads the checks of a pull request by its number when the branch name is also a number', async (t) => {
  const dir = await fakePrGh(t, 128);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await waitForChecks(repo, 128, { ...PR_WAIT, head: 'abc' }), 'fail');
  assert.match(await failedCheckLogs(repo, 128, 1000), /boom/);
});
