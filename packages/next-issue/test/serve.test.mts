import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { onStop } from '../src/children.mts';
import { run, type RunResult } from '../src/exec.mts';
import type { WorkerMessage } from '../src/protocol.mts';
import { startWorker } from '../src/serve.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRuns, noQuestions, runsOf, worker } from './worker-harness.mts';

test('a client that connects gets the worker version and the runs', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  assert.deepEqual(await client.next((value) => value.type === 'hello'), {
    type: 'hello',
    version: '2.0.0',
  });
  assert.deepEqual(await client.next(runsOf), { type: 'runs', runs: {} });
});

test('only the user who starts the worker can open its socket file', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
});

test('a worker that starts under an open umask never leaves its socket file open to others', async (t) => {
  const before = process.umask(0);
  t.after(() => process.umask(before));
  const modes: number[] = [];
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const result = listen.apply(this, args as Parameters<typeof listen>);
    if (typeof args[0] === 'string') {
      modes.push(statSync(args[0]).mode & 0o777);
    }
    return result;
  });
  await worker(t, fakeRuns());
  assert.deepEqual(modes, [0o600]);
  assert.equal(process.umask(0), 0);
});

test('a client that starts a run sees the progress of every running issue in every client', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const starter = await connect(t, socketPath);
  const watcher = await connect(t, socketPath);
  await watcher.next(runsOf);
  starter.send({ type: 'start', root: '/repo' });
  await watcher.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  assert.equal(fake.calls[0]!.root, '/repo');
  fake.controls().onEvent!({ kind: 'issue.start', issue: 7, ts: '2026-11-02T10:00:00.000Z' });
  fake.controls().onEvent!({ kind: 'issue.start', issue: 8, ts: '2026-11-02T10:00:00.000Z' });
  const running = await watcher.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.issues.length === 2,
  );
  assert.deepEqual(
    running.type === 'runs' && running.runs['/repo']!.issues.map((entry) => entry.issue),
    [7, 8],
  );
  assert.equal(running.type === 'runs' && running.runs['/repo']!.status, 'running');
  fake.finish();
  await watcher.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.status === 'finished',
  );
});

test('a client that starts a second run in the same repository gets an error', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  client.send({ type: 'start', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'a run is going in this repository already',
  });
  assert.equal(fake.calls.length, 1);
});

test('a client that starts a run with --hunt gets a run that hunts and watches', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--hunt', '--max', '3'] });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  assert.equal(fake.calls[0]!.args.hunt, true);
  assert.equal(fake.calls[0]!.args.watch, true);
  assert.equal(fake.calls[0]!.args.max, 3);
});

test('a client that starts a run with a command or a flag that start does not take gets an error and no run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  for (const [args, message] of [
    [['init'], 'start does not take init'],
    [['--json'], 'start does not take --json'],
    [['--force'], 'start does not take --force'],
    [['--help'], 'start does not take --help'],
    [['--merge'], 'Unknown argument: --merge'],
  ] as const) {
    client.send({ type: 'start', root: '/repo', args: [...args] });
    assert.deepEqual(await client.next((value) => value.type === 'error'), {
      type: 'error',
      root: '/repo',
      message,
    });
  }
  assert.equal(fake.calls.length, 0);
});

async function startedRun(t: TestContext, fake = fakeRuns()) {
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  return { fake, client, socketPath };
}

const stopping = (value: WorkerMessage) =>
  value.type === 'runs' && value.runs['/repo']?.status === 'stopping';

const stoppedRun = (value: WorkerMessage) =>
  value.type === 'runs' && value.runs['/repo']?.status === 'stopped';

test('a client that stops a run with no point sees it claim nothing new, finish its issues and end as stopped', async (t) => {
  const { fake, client } = await startedRun(t);
  const controls = fake.controls();
  const asleep = controls.interrupts.sleep(60_000);
  client.send({ type: 'stop', root: '/repo' });
  await client.next(stopping);
  assert.equal(controls.interrupts.afterIssue(), true);
  assert.equal(controls.interrupts.afterRound(), false);
  assert.equal(await asleep, false);
  fake.finish();
  await client.next(stoppedRun);
});

test('a client that stops a run after the round sees each issue stop after its round and the run end as stopped', async (t) => {
  const { fake, client } = await startedRun(t);
  const controls = fake.controls();
  client.send({ type: 'stop', root: '/repo', after: 'round' });
  await client.next(stopping);
  assert.equal(controls.interrupts.afterIssue(), true);
  assert.equal(controls.interrupts.afterRound(), true);
  fake.finish();
  await client.next(stoppedRun);
});

test('a client that asks for an earlier stop point gets it, and a later one changes nothing', async (t) => {
  const { fake, client } = await startedRun(t);
  const controls = fake.controls();
  client.send({ type: 'stop', root: '/repo', after: 'issue' });
  await client.next(stopping);
  assert.equal(controls.interrupts.afterRound(), false);
  client.send({ type: 'stop', root: '/repo', after: 'round' });
  for (let left = 100; left > 0 && !controls.interrupts.afterRound(); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controls.interrupts.afterRound(), true);
  client.send({ type: 'stop', root: '/repo', after: 'issue' });
  client.send({ type: 'stop', root: '/repo' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(controls.interrupts.afterRound(), true);
});

test('a client that stops a run now sees its agents and commands stop at once while the worker keeps answering', async (t) => {
  const fake = fakeRuns();
  let agentStopped = false;
  let command: Promise<RunResult> | undefined;
  let later: Promise<unknown> | undefined;
  const runRepo: typeof fake.runRepo = (root, args, controls) => {
    onStop(() => {
      agentStopped = true;
    });
    command = run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
    later = command.then(() =>
      run(process.execPath, ['-e', '']).then(
        () => 'ran',
        (error: unknown) => (error as Error).message,
      ),
    );
    return fake.runRepo(root, args, controls);
  };
  const outside = run(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  const { client, socketPath } = await startedRun(t, { ...fake, runRepo });
  client.send({ type: 'stop', root: '/repo', after: 'now' });
  await client.next(stopping);
  assert.notEqual((await command!).code, 0);
  assert.equal(agentStopped, true);
  assert.equal(await later, 'The run stopped.');
  assert.equal(fake.controls().interrupts.afterRound(), true);
  assert.equal((await outside).code, 0);
  const another = await connect(t, socketPath);
  await another.next((value) => value.type === 'hello');
  fake.finish();
  await client.next(stoppedRun);
});

test('a client that stops a run with an unknown point gets an error and the run goes on', async (t) => {
  const { fake, client } = await startedRun(t);
  client.send({ type: 'stop', root: '/repo', after: 'tool' } as never);
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'stop does not take --after tool',
  });
  assert.equal(fake.controls().interrupts.afterIssue(), false);
});

test('a client that sends start, stop or questions for another repository gets an error and no run starts or stops', async (t) => {
  const asked: string[] = [];
  const questions: typeof noQuestions = async (root) => {
    asked.push(root);
    return [];
  };
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake, '2.0.0', questions);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  for (const value of [
    { type: 'start', root: '/repo/' },
    { type: 'stop', root: '/other', after: 'now' },
    { type: 'questions', root: '/other' },
  ] as const) {
    client.send(value);
    assert.deepEqual(await client.next((reply) => reply.type === 'error'), {
      type: 'error',
      root: value.root,
      message: 'the worker serves /repo only',
    });
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  assert.deepEqual(
    asked.filter((root) => root !== '/repo'),
    [],
  );
});

test('a second worker does not start while the first one holds the lock', async (t) => {
  const fake = fakeRuns();
  const { socketPath, lockPath } = await worker(t, fake);
  assert.equal(
    await startWorker({
      root: '/repo',
      socketPath,
      lockPath,
      version: '2.0.0',
      runRepo: fake.runRepo,
      questions: noQuestions,
      lockWaitMs: 0,
    }),
    undefined,
  );
});

test('a worker started while the last one closes takes the lock once it is released', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  await writeFile(lockPath, `${process.pid}\n`);
  setTimeout(() => void rm(lockPath, { force: true }), 100);
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    questions: noQuestions,
  });
  assert.ok(started);
  t.after(() => started.close());
  await connect(t, socketPath);
});

test('a worker that no client connects to closes and removes its socket and lock', async () => {
  const dir = await tempDir();
  const started = await startWorker({
    root: '/repo',
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    questions: noQuestions,
    idleMs: 50,
  });
  assert.ok(started);
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a worker takes over the lock and the socket file that a dead worker left', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  await writeFile(lockPath, '999999999\n');
  await writeFile(socketPath, '');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    questions: noQuestions,
  });
  assert.ok(started);
  t.after(() => started.close());
  await connect(t, socketPath);
});

test('a worker that meets a newer client closes once no run is going', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  client.send({ type: 'hello', version: '2.1.0' });
  client.send({ type: 'start', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'the worker is restarting, try again soon',
  });
  fake.finish();
  await started.closed;
  await client.closed;
});

test('a worker that meets an older or equal client keeps running', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'hello', version: '1.9.9' });
  client.send({ type: 'hello', version: '2.0.0' });
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  assert.equal(fake.calls.length, 1);
});

test('a worker closes and removes its socket and lock once the last client leaves and no run is going', async (t) => {
  const { socketPath, dir, worker: started } = await worker(t, fakeRuns());
  const first = await connect(t, socketPath);
  const second = await connect(t, socketPath);
  await first.next(runsOf);
  await second.next(runsOf);
  await first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await readdir(dir)).sort(), ['w.lock', 'w.sock']);
  await second.close();
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a worker whose last client leaves during a run keeps the run going and closes when it ends', async (t) => {
  const fake = fakeRuns();
  const { socketPath, dir, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await readdir(dir)).sort(), ['w.lock', 'w.sock']);
  fake.finish();
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a client starts a run in one repository while the worker of another repository waits to restart', async (t) => {
  const busy = fakeRuns();
  const other = fakeRuns();
  const first = await worker(t, busy);
  const second = await worker(t, other);
  const waiting = await connect(t, first.socketPath);
  waiting.send({ type: 'start', root: '/repo' });
  await waiting.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  waiting.send({ type: 'hello', version: '2.1.0' });
  const client = await connect(t, second.socketPath);
  client.send({ type: 'hello', version: '2.0.0' });
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'running');
  assert.equal(other.calls.length, 1);
  busy.finish();
  other.finish();
});
