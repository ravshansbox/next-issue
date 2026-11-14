import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { failedBaseLogs, rerunFailedBase, waitForBaseChecks } from '../src/base-checks.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

type External = { checkRuns?: unknown[]; statuses?: unknown[][] };

function jsonLines(items: unknown[]): string {
  return items.map((item) => `${JSON.stringify(item)}\n`).join('');
}

async function fakeRunsGh(
  t: TestContext,
  runs: unknown[],
  rerunRuns: unknown[] = runs,
  { checkRuns = [], statuses = [[]] }: External = {},
): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, 'check-runs'), jsonLines(checkRuns));
  await writeFile(join(dir, 'runs'), jsonLines(runs));
  await writeFile(join(dir, 'rerun-runs'), jsonLines(rerunRuns));
  for (const [index, reply] of statuses.entries()) {
    await writeFile(join(dir, `status.${index}`), jsonLines(reply));
  }
  await writeFile(join(dir, 'status.last'), jsonLines(statuses.at(-1) ?? []));
  const script = `#!/bin/sh
d="$(dirname "$0")"
case "$*" in
  "api --paginate repos/acme/tool/actions/runs?head_sha=abc&per_page=100 --jq "*) if [ -f "$d/reruns" ]; then cat "$d/rerun-runs"; else cat "$d/runs"; fi; exit 0 ;;
  "api --paginate repos/acme/tool/commits/abc/check-runs?per_page=100 --jq "*) cat "$d/check-runs"; exit 0 ;;
  "api --paginate repos/acme/tool/commits/abc/status?per_page=100 --jq "*) n=$(cat "$d/status-reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/status-reads"; f="$d/status.$n"; [ -f "$f" ] || f="$d/status.last"; cat "$f"; exit 0 ;;
esac
case "$1 $2" in
  "run view") echo "boom in $3" ;;
  "run rerun") [ "$4" = "--failed" ] || { echo "unexpected: $*" >&2; exit 1; }; echo "$3" >> "$(dirname "$0")/reruns" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

const BASE_WAIT = { intervalSeconds: 1, graceMs: 0, timeoutMs: 10_000 };

test('waitForBaseChecks passes when every run on the commit ends without a failure or a cancel', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' },
    { databaseId: 2, name: 'Deploy', status: 'completed', conclusion: 'success' },
    { databaseId: 3, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'pass',
  );
});

test('waitForBaseChecks reports cancelled when every run on the commit was cancelled before it finished', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'cancelled',
  );
});

test('waitForBaseChecks reports cancelled when the CI run on the commit was cancelled and another workflow succeeded', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'ci', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 2, name: 'release', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'cancelled',
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

function passedRuns(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    databaseId: index + 1,
    name: `Package ${index + 1}`,
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
  }));
}

test('waitForBaseChecks fails when the commit has more than 20 runs and one beyond the first 20 fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    ...passedRuns(20),
    { databaseId: 21, name: 'Release', status: 'completed', conclusion: 'failure', attempt: 1 },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedBase and failedBaseLogs cover a failed run beyond the first 20 runs on the commit', async (t) => {
  const failed = { databaseId: 21, name: 'Release', status: 'completed', conclusion: 'failure' };
  const dir = await fakeRunsGh(
    t,
    [...passedRuns(20), { ...failed, attempt: 1 }],
    [...passedRuns(20), { ...failed, status: 'queued', conclusion: '', attempt: 2 }],
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  const report = await failedBaseLogs(repo, 'abc', 1000);
  assert.match(report, /## Release/);
  assert.match(report, /boom in 21/);
  assert.deepEqual(await rerunFailedBase(repo, 'abc'), ['21']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '21\n');
});

test('waitForBaseChecks reports none when the commit starts no run', async (t) => {
  const dir = await fakeRunsGh(t, []);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'none',
  );
});

test('waitForBaseChecks fails when a check run from a CI other than GitHub Actions fails on the commit', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    checkRuns: [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        app: 'circleci-checks',
        url: 'https://ci.example/1',
      },
    ],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks fails when a check run from a CI other than GitHub Actions waits for someone to act on the commit', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    checkRuns: [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'action_required',
        app: 'circleci-checks',
        url: 'https://ci.example/1',
      },
    ],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks waits for a pending commit status and fails when it then fails', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [
      [{ name: 'ci/jenkins', state: 'pending', url: 'https://ci.example/2' }],
      [{ name: 'ci/jenkins', state: 'failure', url: 'https://ci.example/2' }],
    ],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks times out while a commit status stays pending', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [[{ name: 'ci/jenkins', state: 'pending', url: '' }]],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', {
      ...BASE_WAIT,
      timeoutMs: 1500,
    }),
    'timeout',
  );
});

test('waitForBaseChecks passes when every run and every commit status on the commit succeeds', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [{ databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' }],
    [],
    {
      checkRuns: [
        { name: 'CI job', status: 'in_progress', conclusion: null, app: 'github-actions', url: '' },
      ],
      statuses: [[{ name: 'ci/jenkins', state: 'success', url: '' }]],
    },
  );
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', BASE_WAIT),
    'pass',
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

test('failedBaseLogs names the failed checks from other CI services with their links', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    checkRuns: [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        app: 'circleci-checks',
        url: 'https://ci.example/1',
      },
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        app: 'circleci-checks',
        url: 'https://ci.example/3',
      },
    ],
    statuses: [[{ name: 'ci/jenkins', state: 'error', url: 'https://ci.example/2' }]],
  });
  const report = await failedBaseLogs({ owner: 'acme', name: 'tool', root: dir }, 'abc', 1000);
  assert.match(report, /## build\nhttps:\/\/ci\.example\/1/);
  assert.match(report, /## ci\/jenkins\nhttps:\/\/ci\.example\/2/);
  assert.doesNotMatch(report, /lint/);
});
