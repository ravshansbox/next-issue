import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSocketPath, startWorker } from '../src/serve.mts';
import { connect, fakeRuns, noQuestions, runsOf, worker } from './worker-harness.mts';
import { tempDir } from './temp-dir.mts';

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
  starter.send({ type: 'start', root: '/repo', merge: true });
  await watcher.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  assert.equal(fake.calls[0]!.root, '/repo');
  assert.equal(fake.calls[0]!.args.merge, true);
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
  client.send({ type: 'start', root: '/repo', merge: true });
  client.send({ type: 'start', root: '/repo', merge: true });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'a run is going in this repository already',
  });
  assert.equal(fake.calls.length, 1);
});

test('a client that stops a run sees it stop after the round and end as stopped', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', merge: false });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  const controls = fake.controls();
  const asleep = controls.interrupts.sleep(60_000);
  client.send({ type: 'stop', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'stopping');
  assert.equal(controls.interrupts.afterRound(), true);
  assert.equal(controls.interrupts.afterIssue(), true);
  assert.equal(await asleep, false);
  fake.finish();
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'stopped');
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
  client.send({ type: 'start', root: '/repo', merge: true });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  client.send({ type: 'hello', version: '2.1.0' });
  client.send({ type: 'start', root: '/other', merge: true });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/other',
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
  client.send({ type: 'start', root: '/repo', merge: true });
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
  client.send({ type: 'start', root: '/repo', merge: true });
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
  waiting.send({ type: 'start', root: '/repo', merge: true });
  await waiting.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  waiting.send({ type: 'hello', version: '2.1.0' });
  const client = await connect(t, second.socketPath);
  client.send({ type: 'hello', version: '2.0.0' });
  client.send({ type: 'start', root: '/repo', merge: true });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'running');
  assert.equal(other.calls.length, 1);
  busy.finish();
  other.finish();
});

test('a worker whose socket path is too long for the system says so', () => {
  assert.throws(
    () => checkSocketPath(`/${'a'.repeat(103)}`, 'darwin'),
    /the socket path \/a+ is too long for this system: 104 bytes, at most 103/,
  );
  assert.doesNotThrow(() => checkSocketPath(`/${'a'.repeat(102)}`, 'darwin'));
  assert.doesNotThrow(() => checkSocketPath(`/${'a'.repeat(106)}`, 'linux'));
});
