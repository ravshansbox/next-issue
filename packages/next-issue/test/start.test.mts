import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { onStop } from '../src/children.mts';
import { must } from '../src/exec.mts';
import { type RunRepo, startWorker } from '../src/serve.mts';
import { packageVersion } from '../src/version.mts';
import { workerPaths } from '../src/worker-paths.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRuns, noQuestions } from './worker-harness.mts';

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
  const child = spawn(process.execPath, [CLI, 'start', ...args], { cwd: root, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  t.after(() => child.kill('SIGKILL'));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
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
    questions: noQuestions,
  });
  assert.ok(worker);
  t.after(() => worker.close());
  return worker;
}

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
  const started = startCommand(t, root, [], env);
  assert.equal(await started.exited, 0);
  assert.match(workerOutput, / run\.start /);
  assert.match(started.stderr(), / run\.start /);
  assert.match(started.stdout(), /\S/);
});

test('a user who runs start gets the text summary of the run on stdout', async (t) => {
  const root = await repository();
  const started = startCommand(t, root, [], await idleGh());
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
    const started = startCommand(t, root, ['--watch']);
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

test('a user who runs start with --force sees the run go as without it', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo);
  const started = startCommand(t, root, ['--force']);
  await until(
    () => fake.calls.length === 1 || started.stderr().includes('failed'),
    'the run to start',
  );
  assert.doesNotMatch(started.stderr(), /failed/);
  fake.finish();
  assert.equal(await started.exited, 0);
});

test('a user who runs start while an older worker has a watch run going sees start refused and the watch run go on', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  await fakeWorker(t, root, fake.runRepo, '0.0.0-old');
  const other = await connect(t, workerPaths(root).socketPath);
  other.send({ type: 'start', root, args: ['--watch'] });
  await other.next((value) => value.type === 'runs' && value.runs[root]?.status === 'running');
  const started = startCommand(t, root, []);
  assert.equal(await started.exited, 1);
  assert.match(started.stderr(), /a run is going in this repository already/);
  const observer = await connect(t, workerPaths(root).socketPath);
  const runs = await observer.next((value) => value.type === 'runs');
  assert.equal(runs.type === 'runs' && runs.runs[root]?.status, 'running');
  assert.equal(runs.type === 'runs' && runs.runs[root]?.upgrade, undefined);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  fake.finish();
});

test('a user whose start run watches while a newer client connects sees the run keep its flags and go on, and start exit only when it ends', async (t) => {
  const root = await repository();
  const fake = fakeRuns();
  const worker = await fakeWorker(t, root, fake.runRepo);
  const started = startCommand(t, root, ['--watch', '--hunt']);
  await until(() => fake.calls.length === 1, 'the run to start');
  const newer = await connect(t, workerPaths(root).socketPath);
  newer.send({ type: 'hello', version: '999.0.0' });
  newer.send({ type: 'questions', root, id: 'after' });
  await newer.next((value) => value.type === 'questions' && value.id === 'after');
  const observer = await connect(t, workerPaths(root).socketPath);
  const runs = await observer.next((value) => value.type === 'runs');
  assert.equal(runs.type === 'runs' && runs.runs[root]?.status, 'running');
  assert.equal(runs.type === 'runs' && runs.runs[root]?.upgrade, undefined);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  assert.equal(started.child.exitCode, null);
  assert.equal(fake.calls[0]!.args.watch, true);
  assert.equal(fake.calls[0]!.args.hunt, true);
  fake.finish();
  assert.equal(await started.exited, 0);
  await worker.closed;
});
