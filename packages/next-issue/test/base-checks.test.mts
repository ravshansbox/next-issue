import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { failedBaseLogs, rerunFailedBase, waitForBaseChecks } from '../src/base-checks.mts';
import { pollChecks } from '../src/check-poll.mts';
import { fakeClock } from './fake-clock.mts';
import { installGh } from './fake-gh.mts';
import { harness } from './harness.mts';
import { tempDir } from './temp-dir.mts';

type External = { checkRuns?: unknown[]; statuses?: unknown[][]; sha?: string };

function jsonLines(items: unknown[]): string {
  return items.map((item) => `${JSON.stringify(item)}\n`).join('');
}

function pushRuns(runs: unknown[]): unknown[] {
  return runs.map((entry) => ({ event: 'push', branch: 'main', ...(entry as object) }));
}

async function fakeRunsGh(
  t: TestContext,
  runs: unknown[],
  rerunRuns: unknown[] = runs,
  { checkRuns = [], statuses = [[]], sha = 'abc' }: External = {},
): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, 'check-runs'), jsonLines(checkRuns));
  await writeFile(join(dir, 'runs'), jsonLines(pushRuns(runs)));
  await writeFile(join(dir, 'rerun-runs'), jsonLines(pushRuns(rerunRuns)));
  for (const [index, reply] of statuses.entries()) {
    await writeFile(join(dir, `status.${index}`), jsonLines(reply));
  }
  await writeFile(join(dir, 'status.last'), jsonLines(statuses.at(-1) ?? []));
  const script = `#!/bin/sh
d="$(dirname "$0")"
case "$*" in
  "api --paginate repos/acme/tool/actions/runs?head_sha=${sha}&per_page=100 --jq "*) if [ -f "$d/reruns" ]; then cat "$d/rerun-runs"; else cat "$d/runs"; fi; exit 0 ;;
  "api --paginate repos/acme/tool/commits/${sha}/check-runs?per_page=100 --jq "*) cat "$d/check-runs"; exit 0 ;;
  "api --paginate repos/acme/tool/commits/${sha}/status?per_page=100 --jq "*) n=$(cat "$d/status-reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/status-reads"; f="$d/status.$n"; [ -f "$f" ] || f="$d/status.last"; cat "$f"; exit 0 ;;
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('waitForBaseChecks reports cancelled when every run on the commit was cancelled before it finished', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'cancelled',
  );
});

test('waitForBaseChecks reports cancelled when the CI run on the commit was cancelled and another workflow succeeded', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'ci', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 2, name: 'release', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'cancelled',
  );
});

test('waitForBaseChecks fails as soon as one run on the commit fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Deploy', status: 'in_progress', conclusion: '' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks fails when a workflow run on the commit ends waiting for someone to approve it', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'action_required' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedBase reruns a failed workflow run and leaves one that waits for approval alone', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'action_required', attempt: 1 },
      { databaseId: 2, name: 'Lint', status: 'completed', conclusion: 'failure', attempt: 1 },
    ],
    [
      { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'action_required', attempt: 1 },
      { databaseId: 2, name: 'Lint', status: 'queued', conclusion: '', attempt: 2 },
    ],
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.deepEqual(await rerunFailedBase(repo, 'abc', 'main'), ['2']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '2\n');
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
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
  const report = await failedBaseLogs(repo, 'abc', 'main', 1000);
  assert.match(report, /## Release/);
  assert.match(report, /boom in 21/);
  assert.deepEqual(await rerunFailedBase(repo, 'abc', 'main'), ['21']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '21\n');
});

test('waitForBaseChecks reports none when the commit starts no run', async (t) => {
  const dir = await fakeRunsGh(t, []);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForBaseChecks fails when a failing commit status shows up after the first check has passed', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [
      [{ name: 'app/lint', state: 'success', url: '' }],
      [
        { name: 'app/lint', state: 'success', url: '' },
        { name: 'ci/jenkins', state: 'failure', url: 'https://ci.example/3' },
      ],
    ],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', {
      ...BASE_WAIT,
      graceMs: 1500,
    }),
    'fail',
  );
});

test('waitForBaseChecks times out while a commit status stays pending', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [[{ name: 'ci/jenkins', state: 'pending', url: '' }]],
  });
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', {
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
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
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
  const sent: string[] = [];
  const runs = await rerunFailedBase(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    () => {
      sent.push('started');
    },
  );
  assert.deepEqual(runs, ['1']);
  assert.deepEqual(sent, ['started']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '1\n');
});

test('failedBaseLogs gives the logs of the failed runs on the commit only', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]);
  const report = await failedBaseLogs(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    1000,
  );
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
  const report = await failedBaseLogs(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    1000,
  );
  assert.match(report, /## build\nhttps:\/\/ci\.example\/1/);
  assert.match(report, /## ci\/jenkins\nhttps:\/\/ci\.example\/2/);
  assert.doesNotMatch(report, /lint/);
});

const ISSUE_RUNS = [
  { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success', attempt: 1 },
  {
    databaseId: 2,
    name: 'Triage',
    status: 'completed',
    conclusion: 'failure',
    attempt: 1,
    event: 'issues',
  },
  {
    databaseId: 3,
    name: 'Label sync',
    status: 'completed',
    conclusion: 'cancelled',
    attempt: 1,
    event: 'label',
  },
  {
    databaseId: 4,
    name: 'Comment bot',
    status: 'in_progress',
    conclusion: '',
    attempt: 1,
    event: 'issue_comment',
  },
];

test('waitForBaseChecks passes when the push run of the commit passes, whatever the runs that other events started on it do', async (t) => {
  const dir = await fakeRunsGh(t, ISSUE_RUNS);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('rerunFailedBase and failedBaseLogs leave out a failed run that an event other than push started on the commit', async (t) => {
  const dir = await fakeRunsGh(t, ISSUE_RUNS);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await failedBaseLogs(repo, 'abc', 'main', 1000), '');
  assert.deepEqual(await rerunFailedBase(repo, 'abc', 'main'), []);
});

test('a user whose landed commit has a passed push run and a failed issues run gets the issue closed and done', async (t) => {
  const target = await harness(t, { config: { checkGraceSeconds: 0 } });
  await fakeRunsGh(t, ISSUE_RUNS, ISSUE_RUNS, { sha: '2' });
  target.context.ports.waitForBaseChecks = waitForBaseChecks;
  target.context.ports.rerunFailedBase = rerunFailedBase;
  target.context.ports.failedBaseLogs = failedBaseLogs;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.deepEqual(target.reruns, []);
});

const OTHER_REF_RUNS = [
  { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success', attempt: 1 },
  {
    databaseId: 2,
    name: 'Release',
    status: 'completed',
    conclusion: 'failure',
    attempt: 1,
    branch: 'v1.2.3',
  },
  {
    databaseId: 3,
    name: 'Deploy',
    status: 'completed',
    conclusion: 'cancelled',
    attempt: 1,
    branch: 'production',
  },
  {
    databaseId: 4,
    name: 'Publish',
    status: 'in_progress',
    conclusion: '',
    attempt: 1,
    branch: 'v1.2.3',
  },
];

test('waitForBaseChecks passes when the push run of the base branch passes, whatever the push runs of a tag or another branch do', async (t) => {
  const dir = await fakeRunsGh(t, OTHER_REF_RUNS);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('waitForBaseChecks fails when the push run of the base branch fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure', attempt: 1 },
  ]);
  assert.equal(
    await waitForBaseChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedBase and failedBaseLogs leave out a failed push run of a tag or another branch on the commit', async (t) => {
  const dir = await fakeRunsGh(t, OTHER_REF_RUNS);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await failedBaseLogs(repo, 'abc', 'main', 1000), '');
  assert.deepEqual(await rerunFailedBase(repo, 'abc', 'main'), []);
});

test('a user whose landed commit has a passed push run on the base branch and a failed push run on a tag gets the issue closed and done', async (t) => {
  const target = await harness(t, { config: { checkGraceSeconds: 0 } });
  await fakeRunsGh(t, OTHER_REF_RUNS.slice(0, 2), OTHER_REF_RUNS.slice(0, 2), { sha: '2' });
  target.context.ports.waitForBaseChecks = waitForBaseChecks;
  target.context.ports.rerunFailedBase = rerunFailedBase;
  target.context.ports.failedBaseLogs = failedBaseLogs;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.deepEqual(target.reruns, []);
});

test('a user whose landed commit gets a failing commit status after the first check has passed gets the issue handed to a person, not closed', async (t) => {
  const target = await harness(t, {
    config: { checkGraceSeconds: 3, checkIntervalSeconds: 1, maxCiFixes: 0 },
  });
  await fakeRunsGh(t, [], [], {
    sha: '2',
    statuses: [
      [{ name: 'app/lint', state: 'success', url: '' }],
      [
        { name: 'app/lint', state: 'success', url: '' },
        { name: 'ci/jenkins', state: 'failure', url: 'https://ci.example/3' },
      ],
    ],
  });
  target.context.ports.waitForBaseChecks = waitForBaseChecks;
  target.context.ports.rerunFailedBase = rerunFailedBase;
  target.context.ports.failedBaseLogs = failedBaseLogs;
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(target.closed, []);
  assert.ok(target.labels.every((entry) => entry.label !== 'status:done'));
});

test(
  'a user who stops a run now while it waits for pending checks on main with a long check interval gets the issue stopped at once, with no hand-over and the state kept',
  { timeout: 20_000 },
  async (t) => {
    const target = await harness(t, { config: { checkIntervalSeconds: 600 } });
    const dir = await fakeRunsGh(
      t,
      [{ status: 'in_progress', conclusion: null, databaseId: 1 }],
      [],
      { sha: '2' },
    );
    target.context.ports.waitForBaseChecks = (repo, sha, branch, options) => {
      void stopAfterFirstRead(dir, target.stopNow);
      return waitForBaseChecks(repo, sha, branch, options);
    };
    const started = Date.now();
    const report = await target.run();
    assert.equal(report.outcome, 'stopped');
    assert.ok(Date.now() - started < 10_000);
    assert.ok(target.comments.every((comment) => !comment.includes('needs help')));
    assert.equal((await target.state())?.handedOver, undefined);
    assert.equal(target.labels.at(-1)?.label, 'status:in-review');
  },
);

async function stopAfterFirstRead(dir: string, stop: () => void): Promise<void> {
  while (!(await readFile(join(dir, 'status-reads'), 'utf8').catch(() => ''))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
}

for (const [checks, state] of [
  ['some', 'pass'],
  ['none', 'none'],
] as const) {
  test(`a user with a one-minute check timeout and the default grace time whose landed commit has ${state === 'pass' ? 'passing checks' : 'no checks'} gets the issue closed and done`, async (t) => {
    const target = await harness(t, { config: { checkTimeoutMinutes: 1 } });
    const time = fakeClock();
    target.context.ports.waitForBaseChecks = (_repo, _sha, _branch, options) =>
      pollChecks(
        {
          head: async () => '2',
          lags: async () => true,
          list: async () => checks,
          watch: async () => state,
        },
        options,
        time,
      );
    const report = await target.run();
    assert.equal(report.outcome, 'done');
    assert.deepEqual(target.closed, [7]);
    assert.equal(target.labels.at(-1)!.label, 'status:done');
    assert.equal(time.time, 60_000);
  });
}
