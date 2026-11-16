import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { failedCiLogs, rerunFailedCi, waitForCiChecks } from '../src/ci-checks.mts';
import { pollChecks } from '../src/check-poll.mts';
import type { Config } from '../src/config.mts';
import { fakeClock } from './fake-clock.mts';
import { installGh } from './fake-gh.mts';
import { harness } from './harness.mts';
import { tempDir } from './temp-dir.mts';

type External = {
  checkRuns?: unknown[];
  statuses?: unknown[][];
  sha?: string;
  jobs?: Record<number, unknown[]>;
};

function jsonLines(items: unknown[]): string {
  return items.map((item) => `${JSON.stringify(item)}\n`).join('');
}

function pushRuns(runs: unknown[]): unknown[] {
  return runs.map((entry) => ({
    event: 'push',
    branch: 'main',
    ...(entry as object),
  }));
}

async function fakeRunsGh(
  t: TestContext,
  runs: unknown[],
  rerunRuns: unknown[] = runs,
  { checkRuns = [], statuses = [[]], sha = 'abc', jobs = {} }: External = {},
): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, 'check-runs'), jsonLines(checkRuns));
  for (const [id, reply] of Object.entries(jobs)) {
    await writeFile(join(dir, `jobs.${id}`), jsonLines(reply));
  }
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
  "api --paginate repos/acme/tool/actions/runs/"*"/jobs?filter=latest&per_page=100 --jq "*) id="\${3#repos/acme/tool/actions/runs/}"; id="\${id%%/*}"; cat "$d/jobs.$id" 2>/dev/null; exit 0 ;;
  "api --paginate repos/acme/tool/commits/${sha}/status?per_page=100 --jq "*) n=$(cat "$d/status-reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/status-reads"; f="$d/status.$n"; [ -f "$f" ] || f="$d/status.last"; cat "$f"; exit 0 ;;
esac
case "$1 $2" in
  "run view") if [ "$3" = "--job" ]; then echo "boom in job $4"; elif [ -f "$d/log" ]; then cat "$d/log"; else echo "boom in $3"; fi ;;
  "run rerun") [ "$4" = "--failed" ] || { echo "unexpected: $*" >&2; exit 1; }; echo "$3" >> "$(dirname "$0")/reruns" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

const BASE_WAIT = { intervalSeconds: 1, graceMs: 0, timeoutMs: 10_000 };

test('waitForCiChecks passes when every run on the commit ends without a failure or a cancel', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' },
    {
      databaseId: 2,
      name: 'Deploy',
      status: 'completed',
      conclusion: 'success',
    },
    { databaseId: 3, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('waitForCiChecks reports cancelled when every run on the commit was cancelled before it finished', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'cancelled' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'cancelled',
  );
});

test('waitForCiChecks reports cancelled when the CI run on the commit was cancelled and another workflow succeeded', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'ci', status: 'completed', conclusion: 'cancelled' },
    {
      databaseId: 2,
      name: 'release',
      status: 'completed',
      conclusion: 'success',
    },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'cancelled',
  );
});

test('waitForCiChecks fails as soon as one run on the commit fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Deploy', status: 'in_progress', conclusion: '' },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForCiChecks fails when a workflow run on the commit ends waiting for someone to approve it', async (t) => {
  const dir = await fakeRunsGh(t, [
    {
      databaseId: 1,
      name: 'CI',
      status: 'completed',
      conclusion: 'action_required',
    },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedCi reruns a failed workflow run and leaves one that waits for approval alone', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      {
        databaseId: 1,
        name: 'CI',
        status: 'completed',
        conclusion: 'action_required',
        attempt: 1,
      },
      {
        databaseId: 2,
        name: 'Lint',
        status: 'completed',
        conclusion: 'failure',
        attempt: 1,
      },
    ],
    [
      {
        databaseId: 1,
        name: 'CI',
        status: 'completed',
        conclusion: 'action_required',
        attempt: 1,
      },
      {
        databaseId: 2,
        name: 'Lint',
        status: 'queued',
        conclusion: '',
        attempt: 2,
      },
    ],
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main'), ['2']);
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

test('waitForCiChecks fails when the commit has more than 20 runs and one beyond the first 20 fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    ...passedRuns(20),
    {
      databaseId: 21,
      name: 'Release',
      status: 'completed',
      conclusion: 'failure',
      attempt: 1,
    },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedCi and failedCiLogs cover a failed run beyond the first 20 runs on the commit', async (t) => {
  const failed = {
    databaseId: 21,
    name: 'Release',
    status: 'completed',
    conclusion: 'failure',
  };
  const dir = await fakeRunsGh(
    t,
    [...passedRuns(20), { ...failed, attempt: 1 }],
    [...passedRuns(20), { ...failed, status: 'queued', conclusion: '', attempt: 2 }],
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  const report = await failedCiLogs(repo, 'abc', 'main', 1000);
  assert.match(report, /## Release/);
  assert.match(report, /boom in 21/);
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main'), ['21']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '21\n');
});

test('waitForCiChecks reports none when the commit starts no run', async (t) => {
  const dir = await fakeRunsGh(t, []);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'none',
  );
});

test('waitForCiChecks fails when a check run from a CI other than GitHub Actions fails on the commit', async (t) => {
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
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForCiChecks fails when a check run from a CI other than GitHub Actions waits for someone to act on the commit', async (t) => {
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
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForCiChecks waits for a pending commit status and fails when it then fails', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [
      [{ name: 'ci/jenkins', state: 'pending', url: 'https://ci.example/2' }],
      [{ name: 'ci/jenkins', state: 'failure', url: 'https://ci.example/2' }],
    ],
  });
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('waitForCiChecks fails when a failing commit status shows up after the first check has passed', async (t) => {
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
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', {
      ...BASE_WAIT,
      graceMs: 1500,
    }),
    'fail',
  );
});

test('waitForCiChecks times out while a commit status stays pending', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    statuses: [[{ name: 'ci/jenkins', state: 'pending', url: '' }]],
  });
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', {
      ...BASE_WAIT,
      timeoutMs: 1500,
    }),
    'timeout',
  );
});

test('waitForCiChecks passes when every run and every commit status on the commit succeeds', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [{ databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' }],
    [],
    {
      checkRuns: [
        {
          name: 'CI job',
          status: 'in_progress',
          conclusion: null,
          app: 'github-actions',
          url: '',
        },
      ],
      statuses: [[{ name: 'ci/jenkins', state: 'success', url: '' }]],
    },
  );
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('rerunFailedCi reruns the failed jobs of the failed runs on the commit only and returns once they restart', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      {
        databaseId: 1,
        name: 'CI',
        status: 'completed',
        conclusion: 'failure',
        attempt: 1,
      },
      {
        databaseId: 2,
        name: 'Docs',
        status: 'completed',
        conclusion: 'success',
        attempt: 1,
      },
    ],
    [
      {
        databaseId: 1,
        name: 'CI',
        status: 'queued',
        conclusion: '',
        attempt: 2,
      },
      {
        databaseId: 2,
        name: 'Docs',
        status: 'completed',
        conclusion: 'success',
        attempt: 1,
      },
    ],
  );
  const sent: string[] = [];
  const runs = await rerunFailedCi(
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

test('failedCiLogs gives the logs of the failed runs on the commit only', async (t) => {
  const dir = await fakeRunsGh(t, [
    { databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
    { databaseId: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]);
  const report = await failedCiLogs(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    1000,
  );
  assert.match(report, /## CI/);
  assert.match(report, /boom in 1/);
  assert.doesNotMatch(report, /Docs|boom in 2/);
});

test('failedCiLogs names the failed checks from other CI services with their links', async (t) => {
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
  const report = await failedCiLogs(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    1000,
  );
  assert.match(report, /## build\nhttps:\/\/ci\.example\/1/);
  assert.match(report, /## ci\/jenkins\nhttps:\/\/ci\.example\/2/);
  assert.doesNotMatch(report, /lint/);
});

test('failedCiLogs gives the one failed run the whole log budget when external checks failed next to it', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [{ databaseId: 1, name: 'CI', status: 'completed', conclusion: 'failure' }],
    [],
    {
      checkRuns: [
        {
          name: 'deploy',
          status: 'completed',
          conclusion: 'failure',
          app: 'vercel',
          url: '',
        },
        {
          name: 'bot',
          status: 'completed',
          conclusion: 'failure',
          app: 'bot',
          url: '',
        },
      ],
      statuses: [[{ name: 'ci/jenkins', state: 'failure', url: '' }]],
    },
  );
  const log = `${'a'.repeat(30)}real error${'b'.repeat(60)}`;
  await writeFile(join(dir, 'log'), log);
  const report = await failedCiLogs({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', 100);
  assert.ok(report.includes(log), report);
  assert.match(report, /## deploy/);
  assert.match(report, /## bot/);
  assert.match(report, /## ci\/jenkins/);
});

const ISSUE_RUNS = [
  {
    databaseId: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
  },
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

test('waitForCiChecks passes when the push run of the commit passes, whatever the runs that other events started on it do', async (t) => {
  const dir = await fakeRunsGh(t, ISSUE_RUNS);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('rerunFailedCi and failedCiLogs leave out a failed run that an event other than push started on the commit', async (t) => {
  const dir = await fakeRunsGh(t, ISSUE_RUNS);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await failedCiLogs(repo, 'abc', 'main', 1000), '');
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main'), []);
});

test('a user whose landed commit has a passed push run and a failed issues run gets the issue closed and done', async (t) => {
  const target = await harness(t, { config: { checkGraceSeconds: 0 } });
  await fakeRunsGh(t, ISSUE_RUNS, ISSUE_RUNS, { sha: '2' });
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  target.context.ports.failedCiLogs = failedCiLogs;
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.deepEqual(target.reruns, []);
});

const OTHER_REF_RUNS = [
  {
    databaseId: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
  },
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

test('waitForCiChecks passes when the push run of the base branch passes, whatever the push runs of a tag or another branch do', async (t) => {
  const dir = await fakeRunsGh(t, OTHER_REF_RUNS);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'pass',
  );
});

test('waitForCiChecks fails when the push run of the base branch fails', async (t) => {
  const dir = await fakeRunsGh(t, [
    {
      databaseId: 1,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      attempt: 1,
    },
  ]);
  assert.equal(
    await waitForCiChecks({ owner: 'acme', name: 'tool', root: dir }, 'abc', 'main', BASE_WAIT),
    'fail',
  );
});

test('rerunFailedCi and failedCiLogs leave out a failed push run of a tag or another branch on the commit', async (t) => {
  const dir = await fakeRunsGh(t, OTHER_REF_RUNS);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await failedCiLogs(repo, 'abc', 'main', 1000), '');
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main'), []);
});

test('a user whose landed commit has a passed push run on the base branch and a failed push run on a tag gets the issue closed and done', async (t) => {
  const target = await harness(t, { config: { checkGraceSeconds: 0 } });
  await fakeRunsGh(t, OTHER_REF_RUNS.slice(0, 2), OTHER_REF_RUNS.slice(0, 2), {
    sha: '2',
  });
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  target.context.ports.failedCiLogs = failedCiLogs;
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
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  target.context.ports.failedCiLogs = failedCiLogs;
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
    target.context.ports.waitForCiChecks = (repo, sha, branch, options) => {
      void stopAfterFirstRead(dir, target.stopNow);
      return waitForCiChecks(repo, sha, branch, options);
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
    target.context.ports.waitForCiChecks = (_repo, _sha, _branch, options) =>
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

type RerunPlan = {
  before?: unknown[][];
  runs: unknown[];
  after: unknown[][];
  afterErrors?: Record<number, string>;
  refuse?: Record<number, string>;
};

type PlannedRun = { databaseId: number; status: string; jobs?: unknown[] };

async function writeRuns(dir: string, file: string, runs: unknown[]): Promise<void> {
  const planned = runs as PlannedRun[];
  await writeFile(
    join(dir, file),
    jsonLines(pushRuns(planned.map((run) => ({ ...run, jobs: undefined })))),
  );
  for (const { databaseId, status, jobs } of planned) {
    if (jobs) {
      await writeFile(join(dir, `${file}.jobs.${databaseId}`), jsonLines(jobs));
    }
    if (status !== 'completed') {
      await writeFile(join(dir, `${file}.running.${databaseId}`), '');
    }
  }
}

async function fakeRerunGh(t: TestContext, plan: RerunPlan): Promise<string> {
  const dir = await tempDir();
  await writeRuns(dir, 'runs', plan.runs);
  for (const [index, reply] of (plan.before ?? []).entries()) {
    await writeRuns(dir, `before.${index}`, reply);
  }
  for (const [index, reply] of plan.after.entries()) {
    await writeRuns(dir, `after.${index}`, reply);
  }
  await writeRuns(dir, 'after.last', plan.after.at(-1) ?? []);
  for (const [index, error] of Object.entries(plan.afterErrors ?? {})) {
    await writeFile(join(dir, `after-error.${index}`), error);
  }
  for (const [id, error] of Object.entries(plan.refuse ?? {})) {
    await writeFile(join(dir, `refuse.${id}`), error);
  }
  const script = `#!/bin/sh
d="$(dirname "$0")"
case "$*" in
  "api --paginate repos/acme/tool/actions/runs?head_sha=2&per_page=100 --jq "*)
    if [ ! -f "$d/reruns" ]; then
      n=$(cat "$d/before-reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/before-reads"
      f="$d/before.$n"; [ -f "$f" ] || f="$d/runs"; echo "$f" > "$d/current"; cat "$f"; exit 0
    fi
    n=$(cat "$d/after-reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/after-reads"
    if [ -f "$d/after-error.$n" ]; then cat "$d/after-error.$n" >&2; exit 1; fi
    f="$d/after.$n"; [ -f "$f" ] || f="$d/after.last"; echo "$f" > "$d/current"; cat "$f"; exit 0 ;;
  "api --paginate repos/acme/tool/actions/runs/"*"/jobs?filter=latest&per_page=100 --jq "*) id="\${3#repos/acme/tool/actions/runs/}"; id="\${id%%/*}"; cat "$(cat "$d/current").jobs.$id" 2>/dev/null; exit 0 ;;
  "api --paginate repos/acme/tool/commits/2/check-runs?per_page=100 --jq "*) exit 0 ;;
  "api --paginate repos/acme/tool/commits/2/status?per_page=100 --jq "*) exit 0 ;;
esac
case "$1 $2" in
  "run view") echo "boom in $3" ;;
  "run rerun")
    if [ -f "$(cat "$d/current").running.$3" ]; then echo "run $3 cannot be rerun; This workflow is already running" >&2; exit 1; fi
    touch "$d/reruns"; if [ -f "$d/refuse.$3" ]; then cat "$d/refuse.$3" >&2; exit 1; fi; echo "$3" >> "$d/rerun-ids" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

async function rerunHarness(t: TestContext, plan: RerunPlan, config: Partial<Config> = {}) {
  const target = await harness(t, {
    config: { checkGraceSeconds: 0, checkIntervalSeconds: 1, ...config },
  });
  const dir = await fakeRerunGh(t, plan);
  const fixerReads: string[] = [];
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  target.context.ports.failedCiLogs = async (...args) => {
    fixerReads.push(await readFile(join(dir, 'after-reads'), 'utf8').catch(() => '0\n'));
    return failedCiLogs(...args);
  };
  return { target, dir, fixerReads };
}

const FAILED_CI = {
  databaseId: 1,
  name: 'CI',
  status: 'completed',
  conclusion: 'failure',
  attempt: 1,
};
const QUEUED_CI = {
  databaseId: 1,
  name: 'CI',
  status: 'queued',
  conclusion: '',
  attempt: 2,
};
const PASSED_CI = {
  databaseId: 1,
  name: 'CI',
  status: 'completed',
  conclusion: 'success',
  attempt: 2,
};
const FAILED_DOCS = {
  databaseId: 2,
  name: 'Docs',
  status: 'completed',
  conclusion: 'failure',
  attempt: 1,
};

test(
  'a user whose read of the restarted runs on main fails after the rerun went through gets the rerun awaited and the issue done with no check fix spent',
  { timeout: 60_000 },
  async (t) => {
    const { target, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI],
      afterErrors: { 0: 'HTTP 403: API rate limit exceeded' },
      after: [[], [FAILED_CI], [QUEUED_CI], [PASSED_CI]],
    });
    const report = await target.run();
    assert.equal(report.outcome, 'done');
    assert.equal(report.ciFixes, 0);
    assert.deepEqual(fixerReads, []);
    assert.deepEqual(target.reverts, []);
  },
);

test(
  'a user whose restarted run on main is missing from the run list for a while gets the rerun awaited and the fixer once it fails again',
  { timeout: 60_000 },
  async (t) => {
    const { target, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI],
      afterErrors: { 0: 'HTTP 403: API rate limit exceeded' },
      after: [[], [], [QUEUED_CI], [{ ...FAILED_CI, attempt: 2 }]],
    });
    await target.run();
    assert.deepEqual(fixerReads, ['5\n']);
    assert.ok(target.prompts.some((entry) => entry.role === 'fixer'));
  },
);

test(
  'a user whose second rerun on main fails after the first went through gets the fixer only once the first rerun ends',
  { timeout: 60_000 },
  async (t) => {
    const { target, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI, FAILED_DOCS],
      refuse: { 2: 'HTTP 403: Must have admin rights to Repository.' },
      after: [
        [QUEUED_CI, FAILED_DOCS],
        [QUEUED_CI, FAILED_DOCS],
        [PASSED_CI, FAILED_DOCS],
      ],
    });
    await target.run();
    assert.deepEqual(fixerReads, ['4\n']);
    const fixer = target.prompts.find((entry) => entry.role === 'fixer');
    assert.match(fixer!.prompt, /boom in 2/);
  },
);

test(
  'a user whose rerun on main GitHub refuses as already running gets the rerun awaited and the issue done with no check fix spent',
  { timeout: 60_000 },
  async (t) => {
    const { target, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI],
      refuse: { 1: 'run 1 cannot be rerun; This workflow is already running' },
      after: [[{ ...QUEUED_CI, status: 'in_progress' }], [PASSED_CI]],
    });
    const report = await target.run();
    assert.equal(report.outcome, 'done');
    assert.equal(report.ciFixes, 0);
    assert.deepEqual(fixerReads, []);
  },
);

const RUNNING_E2E = {
  databaseId: 2,
  name: 'e2e',
  status: 'in_progress',
  conclusion: '',
  attempt: 1,
};
const FAILED_E2E = {
  ...RUNNING_E2E,
  status: 'completed',
  conclusion: 'failure',
};
const QUEUED_E2E = { ...RUNNING_E2E, status: 'queued', attempt: 2 };

test(
  'a user whose second workflow run on main fails only after the rerun of the first started gets the second rerun too and the fixer only once both reruns end',
  { timeout: 60_000 },
  async (t) => {
    const { target, dir, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI, RUNNING_E2E],
      after: [
        [QUEUED_CI, RUNNING_E2E],
        [QUEUED_CI, FAILED_E2E],
        [PASSED_CI, FAILED_E2E],
        [PASSED_CI, FAILED_E2E],
        [PASSED_CI, QUEUED_E2E],
        [PASSED_CI, { ...QUEUED_E2E, status: 'in_progress' }],
        [PASSED_CI, { ...FAILED_E2E, attempt: 2 }],
      ],
    });
    await target.run();
    assert.equal(await readFile(join(dir, 'rerun-ids'), 'utf8'), '1\n2\n');
    assert.deepEqual(fixerReads, ['8\n']);
    const fixer = target.prompts.find((entry) => entry.role === 'fixer');
    assert.match(fixer!.prompt, /boom in 2/);
  },
);

test('rerunFailedCi leaves alone a failed run whose failed jobs were already rerun', async (t) => {
  const dir = await fakeRunsGh(t, [
    { ...FAILED_CI, attempt: 2 },
    { ...FAILED_DOCS, attempt: 1 },
  ]);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main'), ['2']);
  assert.equal(await readFile(join(dir, 'reruns'), 'utf8'), '2\n');
});

test(
  'a user whose rerun on main fails again while a second workflow run still runs gets the second run rerun once it fails and the fixer only after that',
  { timeout: 60_000 },
  async (t) => {
    const REFAILED_CI = { ...FAILED_CI, attempt: 2 };
    const { target, dir, fixerReads } = await rerunHarness(t, {
      runs: [FAILED_CI, RUNNING_E2E],
      after: [
        [QUEUED_CI, RUNNING_E2E],
        [QUEUED_CI, RUNNING_E2E],
        [REFAILED_CI, RUNNING_E2E],
        [REFAILED_CI, RUNNING_E2E],
        [REFAILED_CI, FAILED_E2E],
        [REFAILED_CI, FAILED_E2E],
        [REFAILED_CI, QUEUED_E2E],
        [REFAILED_CI, { ...FAILED_E2E, attempt: 2 }],
      ],
    });
    await target.run();
    assert.equal(await readFile(join(dir, 'rerun-ids'), 'utf8'), '1\n2\n');
    assert.deepEqual(fixerReads, ['9\n']);
  },
);

test('a user whose landed commit fails only a check from another CI service gets the log saying no workflow run was rerun before the fixer', async (t) => {
  const target = await harness(t, {
    config: { checkGraceSeconds: 0, checkIntervalSeconds: 1 },
  });
  await fakeRunsGh(t, [], [], {
    sha: '2',
    checkRuns: [
      {
        name: 'buildkite',
        status: 'completed',
        conclusion: 'failure',
        app: 'buildkite',
        url: '',
      },
    ],
  });
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  await target.run();
  const fixer = target.events.findIndex((event) => event.kind === 'ci-checks.logs');
  const rerun = target.events.findIndex(
    (event) => event.kind === 'ci-checks.rerun' && event.sha === '2',
  );
  assert.ok(rerun !== -1 && (fixer === -1 || rerun < fixer));
  assert.deepEqual(target.events[rerun]!.runs, []);
});

const RELEASE_FAILED_CI = {
  databaseId: 1,
  name: 'ci',
  status: 'completed',
  conclusion: 'failure',
  attempt: 1,
};
const RELEASE_FAILED_JOBS = {
  1: [
    {
      databaseId: 11,
      name: 'check',
      status: 'completed',
      conclusion: 'success',
    },
    {
      databaseId: 12,
      name: 'release',
      status: 'completed',
      conclusion: 'failure',
    },
  ],
};

test('waitForCiChecks passes when the only failed job of a workflow run is in the ignored checks', async (t) => {
  const dir = await fakeRunsGh(t, [RELEASE_FAILED_CI], [], {
    jobs: RELEASE_FAILED_JOBS,
  });
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await waitForCiChecks(repo, 'abc', 'main', BASE_WAIT, [], ['release']), 'pass');
  assert.equal(await waitForCiChecks(repo, 'abc', 'main', BASE_WAIT, [], []), 'fail');
});

test('waitForCiChecks does not wait for an ignored job that still runs once every other job passed', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      {
        databaseId: 1,
        name: 'ci',
        status: 'in_progress',
        conclusion: '',
        attempt: 1,
      },
    ],
    [],
    {
      jobs: {
        1: [
          {
            databaseId: 11,
            name: 'check',
            status: 'completed',
            conclusion: 'success',
          },
          {
            databaseId: 12,
            name: 'release',
            status: 'waiting',
            conclusion: '',
          },
        ],
      },
    },
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await waitForCiChecks(repo, 'abc', 'main', BASE_WAIT, [], ['release']), 'pass');
});

test('waitForCiChecks keeps waiting for a running workflow run whose listed jobs have all finished', async (t) => {
  const dir = await fakeRunsGh(
    t,
    [
      {
        databaseId: 1,
        name: 'ci',
        status: 'in_progress',
        conclusion: '',
        attempt: 1,
      },
    ],
    [],
    {
      jobs: {
        1: [
          {
            databaseId: 11,
            name: 'check',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    },
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(
    await waitForCiChecks(repo, 'abc', 'main', { ...BASE_WAIT, timeoutMs: 1500 }, [], ['release']),
    'timeout',
  );
});

test('waitForCiChecks fails when a job outside the ignored checks fails next to an ignored one', async (t) => {
  const dir = await fakeRunsGh(t, [RELEASE_FAILED_CI], [], {
    jobs: {
      1: [
        {
          databaseId: 11,
          name: 'check',
          status: 'completed',
          conclusion: 'failure',
        },
        {
          databaseId: 12,
          name: 'release',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    },
  });
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await waitForCiChecks(repo, 'abc', 'main', BASE_WAIT, [], ['release']), 'fail');
});

test('waitForCiChecks leaves out a check run and a commit status whose names are in the ignored checks', async (t) => {
  const dir = await fakeRunsGh(t, [], [], {
    checkRuns: [
      {
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        app: 'vercel',
        url: '',
      },
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        app: 'circleci',
        url: '',
      },
    ],
    statuses: [[{ name: 'ci/jenkins', state: 'pending', url: '' }]],
  });
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(
    await waitForCiChecks(repo, 'abc', 'main', BASE_WAIT, [], ['deploy', 'ci/jenkins']),
    'pass',
  );
});

test('rerunFailedCi and failedCiLogs leave out a run whose only failed job is in the ignored checks', async (t) => {
  const dir = await fakeRunsGh(t, [RELEASE_FAILED_CI], [], {
    jobs: RELEASE_FAILED_JOBS,
  });
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await failedCiLogs(repo, 'abc', 'main', 1000, ['release']), '');
  assert.deepEqual(await rerunFailedCi(repo, 'abc', 'main', () => {}, ['release']), []);
});

test('failedCiLogs gives the logs of the failed jobs outside the ignored checks only', async (t) => {
  const dir = await fakeRunsGh(t, [RELEASE_FAILED_CI], [], {
    jobs: {
      1: [
        {
          databaseId: 11,
          name: 'check',
          status: 'completed',
          conclusion: 'failure',
        },
        {
          databaseId: 12,
          name: 'release',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    },
    checkRuns: [
      {
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        app: 'vercel',
        url: '',
      },
    ],
  });
  const report = await failedCiLogs(
    { owner: 'acme', name: 'tool', root: dir },
    'abc',
    'main',
    1000,
    ['release', 'deploy'],
  );
  assert.match(report, /## ci \/ check/);
  assert.match(report, /boom in job 11/);
  assert.doesNotMatch(report, /release|boom in job 12|deploy/);
});

for (const ignoredChecks of [['release'], []]) {
  test(`a user whose landed commit fails only the release job ${ignoredChecks.length > 0 ? 'with release in ignoredChecks gets the issue closed and done' : 'with no ignoredChecks gets the fixer and no close'}`, async (t) => {
    const target = await harness(t, {
      config: {
        checkGraceSeconds: 0,
        checkIntervalSeconds: 1,
        maxCiFixes: 0,
        ignoredChecks,
      },
    });
    await fakeRunsGh(t, [RELEASE_FAILED_CI], [{ ...RELEASE_FAILED_CI, attempt: 2 }], {
      sha: '2',
      jobs: RELEASE_FAILED_JOBS,
    });
    target.context.ports.waitForCiChecks = waitForCiChecks;
    target.context.ports.rerunFailedCi = rerunFailedCi;
    target.context.ports.failedCiLogs = failedCiLogs;
    const report = await target.run();
    if (ignoredChecks.length > 0) {
      assert.equal(report.outcome, 'done');
      assert.deepEqual(target.closed, [7]);
      assert.deepEqual(target.reverts, []);
      assert.deepEqual(target.reruns, []);
    } else {
      assert.equal(report.reason, 'check budget');
      assert.deepEqual(target.closed, []);
      assert.notDeepEqual(target.reverts, []);
    }
  });
}

for (const [runConclusion, reason, comment] of [
  [
    'failure',
    'main checks cut short',
    /needs help\n\nA job in `ignoredChecks` failed on main and GitHub cancelled or skipped another job of its workflow run before it finished/,
  ],
  [
    'cancelled',
    'main checks cancelled',
    /needs help\n\nThe checks on main were cancelled before they finished/,
  ],
] as const) {
  test(`a user whose ignored matrix job fails while a kept one is cancelled in a run that ends ${runConclusion} gets a hand-over with ${reason}`, async (t) => {
    const target = await harness(t, {
      config: {
        checkGraceSeconds: 0,
        checkIntervalSeconds: 1,
        ignoredChecks: ['test (windows-latest)'],
      },
    });
    await fakeRunsGh(t, [{ ...RELEASE_FAILED_CI, conclusion: runConclusion }], [], {
      sha: '2',
      jobs: {
        1: [
          {
            databaseId: 11,
            name: 'test (ubuntu-latest)',
            status: 'completed',
            conclusion: 'cancelled',
          },
          {
            databaseId: 12,
            name: 'test (windows-latest)',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    });
    target.context.ports.waitForCiChecks = waitForCiChecks;
    target.context.ports.rerunFailedCi = rerunFailedCi;
    target.context.ports.failedCiLogs = failedCiLogs;
    const report = await target.run();
    assert.equal(report.outcome, 'needs-human');
    assert.equal(report.reason, reason);
    assert.equal(report.halt, true);
    assert.match(target.comments.at(-1)!, comment);
    assert.deepEqual(target.reverts, []);
  });
}

test('a user whose ignored build job fails so GitHub skips the kept test job that needs it gets a hand-over with main checks cut short and no close', async (t) => {
  const target = await harness(t, {
    config: {
      checkGraceSeconds: 0,
      checkIntervalSeconds: 1,
      ignoredChecks: ['build'],
    },
  });
  await fakeRunsGh(t, [RELEASE_FAILED_CI], [], {
    sha: '2',
    jobs: {
      1: [
        { databaseId: 11, name: 'build', status: 'completed', conclusion: 'failure' },
        { databaseId: 12, name: 'test', status: 'completed', conclusion: 'skipped' },
      ],
    },
  });
  target.context.ports.waitForCiChecks = waitForCiChecks;
  target.context.ports.rerunFailedCi = rerunFailedCi;
  target.context.ports.failedCiLogs = failedCiLogs;
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks cut short');
  assert.equal(report.halt, true);
  assert.match(
    target.comments.at(-1)!,
    /needs help\n\nA job in `ignoredChecks` failed on main and GitHub cancelled or skipped another job of its workflow run/,
  );
  assert.deepEqual(target.closed, []);
  assert.deepEqual(target.reverts, []);
});

const TEST_FAILED = {
  databaseId: 11,
  name: 'test',
  status: 'completed',
  conclusion: 'failure',
};
const RELEASE_RUNNING = {
  databaseId: 12,
  name: 'release',
  status: 'in_progress',
  conclusion: '',
};
const RELEASE_PASSED = {
  ...RELEASE_RUNNING,
  status: 'completed',
  conclusion: 'success',
};
const RUNNING_RUN = {
  databaseId: 1,
  name: 'ci',
  status: 'in_progress',
  conclusion: '',
  attempt: 1,
};

test(
  'a user whose landed commit fails a kept job while an ignored job still runs gets the failure rerun once the run finishes and the issue done, not a timeout hand-over',
  { timeout: 120_000 },
  async (t) => {
    const failing = { ...RUNNING_RUN, jobs: [TEST_FAILED, RELEASE_RUNNING] };
    const { target, dir } = await rerunHarness(
      t,
      {
        before: [[failing], [failing], [failing]],
        runs: [
          {
            ...RUNNING_RUN,
            status: 'completed',
            conclusion: 'failure',
            jobs: [TEST_FAILED, RELEASE_PASSED],
          },
        ],
        after: [
          [
            {
              ...RUNNING_RUN,
              status: 'queued',
              attempt: 2,
              jobs: [{ ...TEST_FAILED, status: 'queued', conclusion: '' }, RELEASE_PASSED],
            },
          ],
          [
            {
              ...RUNNING_RUN,
              status: 'completed',
              conclusion: 'success',
              attempt: 2,
              jobs: [{ ...TEST_FAILED, conclusion: 'success' }, RELEASE_PASSED],
            },
          ],
        ],
      },
      { checkTimeoutMinutes: 1, ignoredChecks: ['release'] },
    );
    const report = await target.run();
    assert.equal(report.outcome, 'done');
    assert.equal(await readFile(join(dir, 'rerun-ids'), 'utf8'), '1\n');
    assert.equal((await target.state())?.halted, undefined);
    assert.deepEqual(target.reverts, []);
  },
);
