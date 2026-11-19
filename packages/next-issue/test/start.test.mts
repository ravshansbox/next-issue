import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasCode } from '../src/shared/errors.mts';
import { lockHolder } from '../src/shared/lock.mts';
import { type RunRepo, startWorker } from '../src/worker/serve.mts';
import { packageVersion } from '../src/shared/version.mts';
import { type Connection, findWorker } from '../src/shared/worker-client.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { idleGh } from './fake-gh.mts';
import { repository, sleep, until } from './helpers.mts';
import { connect, fakeRuns } from './worker-harness.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

const ORIGIN = 'https://github.com/acme/start.git';

type Started = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
};

function startCommand(
  t: TestContext,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Started {
  return cliCommand(t, root, ['start', ...args], env);
}

function cliCommand(
  t: TestContext,
  root: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Started {
  const child = spawn(process.execPath, [CLI, ...argv], { cwd: root, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  t.after(() => child.kill('SIGKILL'));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

async function killWorker(root: string): Promise<void> {
  const holder = await lockHolder(workerPaths(root).lockPath);
  if (holder !== undefined && holder !== process.pid) {
    try {
      process.kill(holder, 'SIGTERM');
    } catch (error) {
      if (!hasCode(error, 'ESRCH')) {
        throw error;
      }
    }
  }
}

async function fakeWorker(
  t: TestContext,
  root: string,
  runRepo: RunRepo,
  version?: string,
  options: Pick<Parameters<typeof startWorker>[0], 'registry' | 'successorLaunch'> = {},
) {
  const { logPath: _logPath, ...paths } = workerPaths(root);
  const worker = await startWorker({
    root,
    ...paths,
    version: version ?? (await packageVersion()),
    runRepo,
    ...options,
  });
  assert.ok(worker);
  t.after(() => worker.close());
  return worker;
}

function withoutExcludeNotes(text: string): string {
  return text.replace(/^added .* to .*\/info\/exclude\n/gm, '');
}

const STARTED =
  'next-issue: the run started in the worker; follow it with next-issue logs and stop it with next-issue stop\n';

test('a user who runs start sees one line that the run started naming logs and stop, nothing on stdout, exit code 0 and the run keep going in the worker', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const observer = await connect(t, workerPaths(root).socketPath);
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutExcludeNotes(started.stderr()), STARTED);
  assert.equal(started.stdout(), '');
  fake.controls().output?.('after start\n');
  await observer.next((value) => value.type === 'output' && value.text === 'after start\n');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  fake.finish();
});

test('a user who runs start with no flags sees start exit with 0 and the run wait for new issues in the worker after a pass instead of ending', async (t) => {
  const root = await repository(ORIGIN);
  t.after(() => killWorker(root));
  const started = startCommand(t, root, [], await idleGh(t));
  assert.equal(await started.exited, 0, started.stderr());
  const log = workerPaths(root).logPath;
  await until(() => / watch\.wait /.test(readFileSync(log, 'utf8')), 'the wait after the pass');
});

test('a user who runs start with --hunt on and --watch off sees an error that hunting needs watching and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  const started = startCommand(t, root, ['--hunt', 'on', '--watch', 'off']);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /hunting needs watching/);
});

test('a user who runs start with --watch and no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  for (const args of [['--watch'], ['--watch', 'yes']]) {
    const started = startCommand(t, root, args);
    assert.equal(await started.exited, 1);
    assert.match(started.stderr(), /--watch takes on or off/);
  }
});

test('a user who runs watch or hunt with a run going sees the run switch, the new setting printed and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  for (const [argv, printed, watching, hunting] of [
    [['hunt', 'on'], 'next-issue: watching on, hunting on\n', true, true],
    [['watch', 'off'], 'next-issue: watching off, hunting off\n', false, false],
    [['watch', 'on'], 'next-issue: watching on, hunting off\n', true, false],
    [['hunt', 'off'], 'next-issue: watching on, hunting off\n', true, false],
  ] as const) {
    const switched = cliCommand(t, root, [...argv]);
    assert.equal(await switched.exited, 0, switched.stderr());
    assert.equal(switched.stdout(), printed);
    assert.equal(fake.controls().watching?.on(), watching);
    assert.equal(fake.controls().hunting?.on(), hunting);
  }
  fake.finish();
});

test('a user who runs watch or hunt with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  for (const argv of [
    ['watch', 'on'],
    ['hunt', 'off'],
  ]) {
    const switched = cliCommand(t, root, argv);
    assert.equal(await switched.exited, 0);
    assert.equal(switched.stdout(), 'next-issue: no run is going in this repository\n');
  }
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const switched = cliCommand(t, root, ['watch', 'off']);
  assert.equal(await switched.exited, 0);
  assert.equal(switched.stdout(), 'next-issue: no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs stop with a run going sees that the run will stop after its current issues, exit code 0 at once, and the worker go on with no signal', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'next-issue: the run will stop after its current issues\n');
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  assert.equal(fake.controls().interrupts.afterRound(), false);
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  fake.finish();
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopped');
});

test('a user who runs stop while the run is stopping sees that it is stopping already and exit code 0', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'stop', root, after: 'round' });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(stopped.stdout(), 'next-issue: the run is stopping already\n');
  assert.equal(fake.controls().interrupts.afterRound(), true);
  fake.finish();
});

test('a user who runs stop while the run stops for an upgrade sees that it will stop and not start again, exit code 0, and the upgrade dropped', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'hello', version: await packageVersion() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  const stopped = cliCommand(t, root, ['stop']);
  assert.equal(await stopped.exited, 0, stopped.stderr());
  assert.equal(
    stopped.stdout(),
    'next-issue: the run will stop after its current issues and not start again\n',
  );
  const dropped = await other.next(
    (value) => value.type === 'runs' && value.runs[root]?.upgrade === undefined,
  );
  assert.equal(dropped.type === 'runs' && dropped.runs[root]!.status, 'stopping');
  fake.finish();
});

test('a user who runs stop with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  const alone = cliCommand(t, root, ['stop']);
  assert.equal(await alone.exited, 0);
  assert.equal(alone.stdout(), 'next-issue: no run is going in this repository\n');
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const idle = cliCommand(t, root, ['stop']);
  assert.equal(await idle.exited, 0);
  assert.equal(idle.stdout(), 'next-issue: no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs status with a run going sees its status, the worker version, watching, hunting and each running issue with its step, exit code 0 and the run unchanged', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--hunt', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const controls = fake.controls();
  controls.onEvent!({ kind: 'issue.start', issue: 624 });
  controls.onEvent!({ kind: 'review.start', issue: 624, round: 2 });
  controls.onEvent!({ kind: 'issue.start', issue: 625 });
  controls.onEvent!({ kind: 'issue.start', issue: 626 });
  controls.onEvent!({ kind: 'ci-checks.start', issue: 626 });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.issues.length === 3);
  const status = cliCommand(t, root, ['status']);
  assert.equal(await status.exited, 0, status.stderr());
  assert.equal(
    status.stdout(),
    [
      `next-issue: the run is running in worker ${await packageVersion()}`,
      'watching on, hunting on',
      '#624 reviewing (round 2)',
      '#625 starting',
      '#626 waiting for checks',
      '',
    ].join('\n'),
  );
  assert.equal(controls.interrupts.afterIssue(), false);
  assert.equal(controls.hunting?.on(), true);
  assert.equal(controls.watching?.on(), true);
  fake.finish();
});

test('a user who runs status while the run stops for an upgrade sees the run stopping, the upgrade and that no issue is running', async (t) => {
  const root = await repository(ORIGIN);
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  other.send({ type: 'hello', version: await packageVersion() });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  const status = cliCommand(t, root, ['status']);
  assert.equal(await status.exited, 0, status.stderr());
  assert.equal(
    status.stdout(),
    [
      'next-issue: the run is stopping in worker 0.0.0-old',
      'watching on, hunting off',
      `stopping for an upgrade to ${await packageVersion()}`,
      'no issue is running',
      '',
    ].join('\n'),
  );
  fake.finish();
});

test('a user who runs status with no worker or no run going sees that no run is going, exit code 0 and no worker started', async (t) => {
  const root = await repository(ORIGIN);
  const alone = cliCommand(t, root, ['status']);
  assert.equal(await alone.exited, 0);
  assert.equal(alone.stdout(), 'next-issue: no run is going in this repository\n');
  await assert.rejects(readFile(workerPaths(root).logPath, 'utf8'));
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const idle = cliCommand(t, root, ['status']);
  assert.equal(await idle.exited, 0);
  assert.equal(idle.stdout(), 'next-issue: no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs watch or hunt with no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository(ORIGIN);
  for (const argv of [['watch'], ['hunt', 'yes']]) {
    const switched = cliCommand(t, root, argv);
    assert.equal(await switched.exited, 1);
    assert.match(switched.stderr(), new RegExp(`${argv[0]} takes on or off`));
  }
});

test('a user who runs start with no worker sees a worker start in the background with its output in .next-issue/worker.log, the started line and exit code 0', async (t) => {
  const root = await repository();
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutExcludeNotes(started.stderr()), STARTED);
  const log = await readFile(workerPaths(root).logPath, 'utf8');
  assert.match(log, /worker listening on .*worker\.sock/);
});

test('a user who runs start while an idle worker is alive sees the run go in that worker, the started line and nothing on stdout', async (t) => {
  const root = await repository(ORIGIN);
  const env = await idleGh(t);
  const worker = spawn(process.execPath, [CLI, 'serve'], { cwd: root, env });
  t.after(() => worker.kill('SIGKILL'));
  let workerOutput = '';
  worker.stderr.on('data', (chunk) => (workerOutput += chunk));
  await until(() => workerOutput.includes('listening'), 'the worker to listen');
  const started = startCommand(t, root, ['--watch', 'off'], env);
  assert.equal(await started.exited, 0);
  await until(() => / run\.start /.test(workerOutput), 'the run to start in the worker');
  assert.equal(withoutExcludeNotes(started.stderr()), STARTED);
  assert.equal(started.stdout(), '');
});

test('a user who runs start while an older idle worker is alive sees it close and the run go in a new worker', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  const older = await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const started = startCommand(t, root, []);
  await older.closed;
  assert.equal(await started.exited, 0, started.stderr());
  assert.equal(withoutExcludeNotes(started.stderr()), STARTED);
  assert.equal(fake.calls.length, 0);
});

test('a user who runs start while an older worker has a watch run going sees start refused with the coming update, and the run go on in the newer worker after its running issues', async (t) => {
  const root = await repository(ORIGIN);
  await idleGh(t);
  t.after(() => killWorker(root));
  const fake = fakeRuns();
  const older = await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 1);
  const version = await packageVersion();
  assert.match(
    started.stderr(),
    new RegExp(
      `a run is going in this repository already; the worker updates to ${version.replaceAll('.', '\\.')} after the running issues`,
    ),
  );
  fake.finish();
  await older.closed;
  let newer: Connection | undefined;
  while (newer?.runs[root] === undefined) {
    newer?.close();
    await sleep(50);
    newer = await findWorker(root);
  }
  t.after(() => newer.close());
  assert.equal(newer.version, version);
  assert.equal(newer.runs[root]?.watching, true);
});
