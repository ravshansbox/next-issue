import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onStop } from '../src/shared/children.mts';
import { lockHolder } from '../src/shared/lock.mts';
import { must } from '../src/shared/exec.mts';
import { type RunRepo, startWorker } from '../src/worker/serve.mts';
import { packageVersion } from '../src/shared/version.mts';
import { rejoinRun } from '../src/shared/worker-client.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRuns } from './worker-harness.mts';

const SUCCESSOR = fileURLToPath(new URL('successor-worker.mts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));

async function repository(remote = true): Promise<string> {
  const root = await realpath(await tempDir());
  await must('git', ['init', '-q'], { cwd: root });
  if (remote) {
    await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/start.git'], {
      cwd: root,
    });
  }
  return root;
}

async function idleGh(): Promise<NodeJS.ProcessEnv> {
  const bin = await tempDir();
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, 'gh'), script, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

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
    process.kill(holder, 'SIGTERM');
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let left = 200; left > 0; left -= 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function fakeWorker(t: TestContext, root: string, runRepo: RunRepo, version?: string) {
  const { logPath: _logPath, ...paths } = workerPaths(root);
  const worker = await startWorker({
    root,
    ...paths,
    version: version ?? (await packageVersion()),
    runRepo,
  });
  assert.ok(worker);
  t.after(() => worker.close());
  return worker;
}

test('a user who runs start with no flags sees the run wait for new issues after a pass instead of ending', async (t) => {
  const root = await repository();
  t.after(() => killWorker(root));
  const started = startCommand(t, root, [], await idleGh());
  await until(() => / watch\.wait /.test(started.stderr()), 'the wait after the pass');
  assert.equal(started.child.exitCode, null);
});

test('a user who runs start with --hunt on and --watch off sees an error that hunting needs watching and exit code 1', async (t) => {
  const root = await repository();
  const started = startCommand(t, root, ['--hunt', 'on', '--watch', 'off']);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /hunting needs watching/);
});

test('a user who runs start with --watch and no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository();
  for (const args of [['--watch'], ['--watch', 'yes']]) {
    const started = startCommand(t, root, args);
    assert.equal(await started.exited, 1);
    assert.match(started.stderr(), /--watch takes on or off/);
  }
});

test('a user who runs watch or hunt with a run going sees the run switch, the new setting printed and exit code 0', async (t) => {
  const root = await repository();
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
  const root = await repository();
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

test('a user who runs refresh while the worker has no run going sees that no run is going and exit code 0', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const refreshed = cliCommand(t, root, ['refresh']);
  assert.equal(await refreshed.exited, 0);
  assert.equal(refreshed.stdout(), 'next-issue: no run is going in this repository\n');
  assert.equal(fake.calls.length, 0);
});

test('a user who runs refresh while the run does not watch or is stopping sees that nothing was asked and exit code 0', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const watchOff = cliCommand(t, root, ['watch', 'off']);
  assert.equal(await watchOff.exited, 0);
  const notWatching = cliCommand(t, root, ['refresh']);
  assert.equal(await notWatching.exited, 0);
  assert.equal(
    notWatching.stdout(),
    'next-issue: the run does not watch for new issues, so nothing was asked\n',
  );
  other.send({ type: 'stop', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'stopping');
  const stopping = cliCommand(t, root, ['refresh']);
  assert.equal(await stopping.exited, 0);
  assert.equal(stopping.stdout(), 'next-issue: the run is stopping, so nothing was asked\n');
  fake.finish();
});

test('a user who runs refresh while an older worker has a run going sees an error to restart the run and exit code 1', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch', 'on'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const refreshed = cliCommand(t, root, ['refresh']);
  assert.equal(await refreshed.exited, 1);
  assert.equal(refreshed.stdout(), '');
  assert.match(
    refreshed.stderr(),
    /the worker of the going run is older than next-issue, so it cannot refresh\. Stop the run, then start it again/,
  );
  fake.finish();
});

test('a user who runs stop with a run going sees that the run will stop after its current issues, exit code 0 at once, and the worker go on with no signal', async (t) => {
  const root = await repository();
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
  const root = await repository();
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
  const root = await repository();
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
  const root = await repository();
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

test('a user who runs watch or hunt with no value or another value sees an error and exit code 1', async (t) => {
  const root = await repository();
  for (const argv of [['watch'], ['hunt', 'yes']]) {
    const switched = cliCommand(t, root, argv);
    assert.equal(await switched.exited, 1);
    assert.match(switched.stderr(), new RegExp(`${argv[0]} takes on or off`));
  }
});

test('a user who runs start with no worker sees a worker start in the background with its output in .next-issue/worker.log, and the run error with exit code 1', async (t) => {
  const root = await repository(false);
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /next-issue failed: .*No such remote 'origin'/);
  const log = await readFile(workerPaths(root).logPath, 'utf8');
  assert.match(log, /worker listening on .*worker\.sock/);
});

test('a user who runs start while an idle worker is alive sees the run go in that worker, its output on stderr and the summary on stdout', async (t) => {
  const root = await repository();
  const env = await idleGh();
  const worker = spawn(process.execPath, [CLI, 'serve'], { cwd: root, env });
  t.after(() => worker.kill('SIGKILL'));
  let workerOutput = '';
  worker.stderr.on('data', (chunk) => (workerOutput += chunk));
  await until(() => workerOutput.includes('listening'), 'the worker to listen');
  const started = startCommand(t, root, ['--watch', 'off'], env);
  assert.equal(await started.exited, 0);
  assert.match(workerOutput, / run\.start /);
  assert.match(started.stderr(), / run\.start /);
  assert.match(started.stdout(), /\S/);
});

test('a user who runs start with --watch off gets the text summary of the run on stdout and exit code 0', async (t) => {
  const root = await repository();
  const started = startCommand(t, root, ['--watch', 'off'], await idleGh());
  assert.equal(await started.exited, 0);
  assert.match(started.stdout(), /^run \S+\nissues 0: .*\ntokens .*\nlog .*\.jsonl\n$/);
});

test('a user who runs start while the worker has a run going sees that a run is going and exit code 1', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /a run is going in this repository already/);
  assert.equal(fake.calls.length, 1);
  fake.finish();
});

test('a user who presses Ctrl-C three times sees the worker stop the run after the issues, then after the round, then at once, with the notes of each press', async (t) => {
  const fake = fakeRuns();
  let stoppedNow = false;
  const runRepo: RunRepo = (root, args, controls) => {
    const drop = onStop(() => {
      stoppedNow = true;
    });
    return fake.runRepo(root, args, controls).finally(drop);
  };
  const root = await repository();
  await fakeWorker(t, root, runRepo);
  const started = startCommand(t, root, []);
  await until(() => fake.calls.length === 1, 'the run to start');
  started.child.kill('SIGINT');
  await until(
    () => started.stderr().includes('Stopping after the running issues.'),
    'the first note',
  );
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  assert.equal(fake.controls().interrupts.afterRound(), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  started.child.kill('SIGINT');
  await until(() => started.stderr().includes('Stopping after the current round.'), 'the note');
  await until(() => fake.controls().interrupts.afterRound(), 'the round stop');
  assert.equal(stoppedNow, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  started.child.kill('SIGINT');
  await until(() => stoppedNow, 'the stop now');
  fake.finish();
  assert.equal(await started.exited, 0);
  assert.deepEqual(
    started
      .stderr()
      .split('\n')
      .filter((line) => line.startsWith('Stopping')),
    [
      'Stopping after the running issues. Press Ctrl-C again to stop after the current round.',
      'Stopping after the current round. Press Ctrl-C again to stop now.',
    ],
  );
});

test('a user whose terminal closes during a run sees the run keep going in the worker', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const started = startCommand(t, root, []);
  await until(() => fake.calls.length === 1, 'the run to start');
  started.child.kill('SIGHUP');
  await started.exited;
  const observer = await connect(t, workerPaths(root).socketPath);
  const runs = await observer.next((value) => value.type === 'runs');
  assert.equal(runs.type === 'runs' && runs.runs[root]?.status, 'running');
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  fake.finish();
});

test('a user who runs start while an older idle worker is alive sees it close and the run go in a new worker', async (t) => {
  const root = await repository(false);
  const fake = fakeRuns();
  const older = await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const started = startCommand(t, root, []);
  await older.closed;
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /No such remote 'origin'/);
  assert.equal(fake.calls.length, 0);
});

test('a user who presses Ctrl-C while the run waits between passes sees "Stopping now.", or the hunt note while a hunt is going', async (t) => {
  for (const hunting of [false, true]) {
    const fake = fakeRuns();
    const root = await repository();
    const worker = await fakeWorker(t, root, fake.runRepo);
    const started = startCommand(t, root, ['--watch', 'on']);
    await until(() => fake.calls.length === 1, 'the run to start');
    const slept = fake.controls().interrupts.sleep(60_000, () => hunting);
    started.child.kill('SIGINT');
    assert.equal(await slept, false);
    const note = hunting
      ? 'Stopping after the current hunt. Press Ctrl-C twice more to stop now.'
      : 'Stopping now.';
    await until(() => started.stderr().includes(note), 'the note');
    fake.finish();
    assert.equal(await started.exited, 0);
    await worker.close();
  }
});

test('a user who runs start while an older worker has a watch run going sees start refused with the coming update, and the run go on in the newer worker after its running issues', async (t) => {
  const root = await repository();
  const path = process.env.PATH;
  process.env.PATH = (await idleGh()).PATH;
  t.after(async () => {
    process.env.PATH = path;
    await killWorker(root);
  });
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
  const newer = await rejoinRun(root);
  assert.ok(newer);
  t.after(() => newer.close());
  assert.equal(newer.version, version);
  assert.equal(newer.runs[root]?.watching, true);
});

async function upgradingStart(
  t: TestContext,
  successorCode: string,
  successorDelayMs = 0,
): Promise<{ root: string; started: Started; finish: (code?: number) => void }> {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  t.after(async () => {
    const holder = await lockHolder(workerPaths(root).lockPath);
    if (holder !== undefined && holder !== process.pid) {
      process.kill(holder, 'SIGKILL');
    }
  });
  const started = startCommand(t, root, ['--hunt', 'on']);
  await until(() => fake.calls.length === 1, 'the run to start');
  const newer = await connect(t, workerPaths(root).socketPath);
  newer.send({
    type: 'hello',
    version: '999.0.0',
    launch: {
      command: process.execPath,
      args: [SUCCESSOR, '999.0.0', successorCode, String(successorDelayMs)],
    },
  });
  await newer.next((value) => value.type === 'runs' && value.runs[root]?.upgrade !== undefined);
  await newer.close();
  return { root, started, finish: fake.finish };
}

test('a user whose start run watches while a newer client connects sees the run go on in the newer worker with its flags, one update note, Ctrl-C still stop it, and start exit with its final code', async (t) => {
  const { started, finish } = await upgradingStart(t, '3');
  finish();
  await until(() => started.stderr().includes('updated'), 'the update note');
  assert.equal(started.child.exitCode, null);
  started.child.kill('SIGINT');
  assert.equal(await started.exited, 3, started.stderr());
  assert.doesNotMatch(started.stderr(), /next-issue failed:/);
  assert.match(started.stderr(), /stopped: watching on, hunting on\n/);
  const version = await packageVersion();
  assert.deepEqual(
    started
      .stderr()
      .split('\n')
      .filter((line) => line.includes('updated')),
    [`next-issue: the worker was updated from ${version} to 999.0.0`],
  );
});

test('a user whose start run watches while a newer client connects sees the run go on in a newer worker that starts listening only after 31 seconds', async (t) => {
  const { started, finish } = await upgradingStart(t, '3', 31_000);
  finish();
  for (let left = 600; !started.stderr().includes('updated'); left -= 1) {
    assert.ok(left > 0 && started.child.exitCode === null, started.stderr());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  started.child.kill('SIGINT');
  assert.equal(await started.exited, 3, started.stderr());
  assert.match(started.stderr(), /stopped: watching on, hunting on\n/);
});

test('a user whose start run had an issue that needed a person before an update sees start exit with 1 after the run ends with 0 on the newer worker', async (t) => {
  const { started, finish } = await upgradingStart(t, '0');
  finish(1);
  await until(() => started.stderr().includes('updated'), 'the update note');
  started.child.kill('SIGINT');
  assert.equal(await started.exited, 1, started.stderr());
  assert.doesNotMatch(started.stderr(), /next-issue failed:/);
});

test('a user who presses Ctrl-C while start moves to the newer worker sees the run stop there after its running issues', async (t) => {
  const { root, started, finish } = await upgradingStart(t, '3');
  finish();
  for (let left = 200; (await lockHolder(workerPaths(root).lockPath)) === process.pid; left -= 1) {
    assert.ok(left > 0, 'timed out waiting for the newer worker');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  started.child.kill('SIGINT');
  assert.equal(await started.exited, 3, started.stderr());
  assert.match(started.stderr(), /Stopping after the running issues/);
  assert.match(started.stderr(), /stopped: watching on, hunting on\n/);
});
