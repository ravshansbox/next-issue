import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createConnection, Server } from 'node:net';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { onStop } from '../src/shared/children.mts';
import { run, type RunResult } from '../src/shared/exec.mts';
import { runIssues } from '../src/shared/loop.mts';
import { Recorder } from '../src/shared/observe.mts';
import type { WorkerMessage } from '../src/shared/protocol.mts';
import { lock, processStart } from '../src/shared/lock.mts';
import { startWorker } from '../src/worker/serve.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { fullDisk } from './full-disk.mts';
import { issue, report } from './loop-harness.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRuns, http, runsOf, worker } from './worker-harness.mts';

const SERVE = new URL('../src/worker/serve.mts', import.meta.url).href;

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

for (const folder of ['My Проекты app', 'a#b?c:d']) {
  test(`a client that connects to a worker in a folder named ${folder} gets the runs`, async (t) => {
    const fake = fakeRuns();
    const { socketPath } = await worker(t, fake, '2.0.0', folder);
    const client = await connect(t, socketPath);
    assert.deepEqual(await client.next(runsOf), { type: 'runs', runs: {} });
  });
}

test('a user who starts the worker is the only user who can open its socket file', async (t) => {
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

test('a client that starts a run sees the run going in every client', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const starter = await connect(t, socketPath);
  const watcher = await connect(t, socketPath);
  await watcher.next(runsOf);
  starter.send({ type: 'start', root: '/repo' });
  await watcher.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'running');
  assert.equal(fake.calls[0]!.root, '/repo');
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

test('a client that starts a run with --hunt on gets a run that hunts and watches', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--hunt', 'on'] });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  assert.equal(fake.calls[0]!.args.hunt, true);
  assert.equal(fake.calls[0]!.args.watch, true);
});

test('a client sees in the progress of each run whether it watches for new issues', async (t) => {
  for (const [args, watching] of [
    [['--watch', 'on'], true],
    [['--watch', 'off'], false],
    [[], true],
  ] as const) {
    const { socketPath } = await worker(t, fakeRuns());
    const client = await connect(t, socketPath);
    client.send({ type: 'start', root: '/repo', args: [...args] });
    const runs = await client.next(
      (value) => value.type === 'runs' && value.runs['/repo'] !== undefined,
    );
    assert.equal(runs.type === 'runs' && runs.runs['/repo']!.watching, watching);
  }
});

const huntingIs = (on: boolean) => (value: WorkerMessage) =>
  value.type === 'runs' && value.runs['/repo']?.hunting === on;

test('a client that switches hunting off and on during a run with --hunt sees the run keep its issues and the hunting field follow, with no restart', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--hunt', 'on'] });
  await client.next(huntingIs(true));
  const controls = fake.controls();
  assert.equal(controls.hunting?.on(), true);
  client.send({ type: 'hunt', root: '/repo', on: false });
  const off = await client.next(huntingIs(false));
  assert.equal(controls.hunting?.on(), false);
  assert.equal(off.type === 'runs' && off.runs['/repo']!.status, 'running');
  const changed = controls.hunting!.changed();
  client.send({ type: 'hunt', root: '/repo', on: true });
  await client.next(huntingIs(true));
  assert.equal(changed.aborted, true);
  assert.equal(controls.hunting?.on(), true);
  assert.equal(fake.calls.length, 1);
  assert.equal(controls.interrupts.afterIssue(), false);
});

test('a client that starts a run with --watch alone sees hunting off, and can switch it on', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(huntingIs(false));
  assert.equal(fake.controls().hunting?.on(), false);
  client.send({ type: 'hunt', root: '/repo', on: true });
  await client.next(huntingIs(true));
  assert.equal(fake.controls().hunting?.on(), true);
});

test('a client that switches hunting on for a run that does not watch sees the run watch and hunt, with no restart', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: [] });
  await client.next(huntingIs(false));
  client.send({ type: 'hunt', root: '/repo', on: true });
  const on = await client.next(huntingIs(true));
  assert.equal(on.type === 'runs' && on.runs['/repo']!.watching, true);
  assert.equal(fake.controls().hunting?.on(), true);
  assert.equal(fake.controls().watching?.on(), true);
  assert.equal(fake.calls.length, 1);
});

const watchingIs = (on: boolean) => (value: WorkerMessage) =>
  value.type === 'runs' && value.runs['/repo']?.watching === on;

test('a client that starts a run with --watch off gets a run that neither watches nor hunts, and can switch watching on and off with no restart', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'off'] });
  const started = await client.next(watchingIs(false));
  assert.equal(started.type === 'runs' && started.runs['/repo']!.hunting, false);
  const controls = fake.controls();
  assert.equal(controls.watching?.on(), false);
  client.send({ type: 'watch', root: '/repo', on: true });
  const on = await client.next(watchingIs(true));
  assert.equal(controls.watching?.on(), true);
  assert.equal(on.type === 'runs' && on.runs['/repo']!.status, 'running');
  const changed = controls.watching!.changed();
  client.send({ type: 'watch', root: '/repo', on: false });
  await client.next(watchingIs(false));
  assert.equal(changed.aborted, true);
  assert.equal(controls.watching?.on(), false);
  assert.equal(fake.calls.length, 1);
  assert.equal(controls.interrupts.afterIssue(), false);
});

test('a client that switches watching off for a run that hunts sees hunting turn off too', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--hunt', 'on'] });
  await client.next(huntingIs(true));
  client.send({ type: 'watch', root: '/repo', on: false });
  const off = await client.next(watchingIs(false));
  assert.equal(off.type === 'runs' && off.runs['/repo']!.hunting, false);
  assert.equal(fake.controls().hunting?.on(), false);
  assert.equal(fake.controls().watching?.on(), false);
});

test('a client that switches watching with no run going gets an error and no run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'watch', root: '/repo', on: true });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'no run is going in this repository',
  });
  assert.equal(fake.calls.length, 0);
});

test('a client that asks a run to refresh after it switched watching on wakes its wait', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'off'] });
  await client.next(watchingIs(false));
  client.send({ type: 'watch', root: '/repo', on: true });
  await client.next(watchingIs(true));
  const refreshed = fake.controls().refreshed!();
  client.send({ type: 'refresh', root: '/repo' });
  client.send(AFTER);
  await client.next(answered);
  assert.equal(refreshed.aborted, true);
});

test('a client whose requests carry an id gets each refusal back with the id of the request it answers', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'hunt', root: '/repo', on: true, id: 'hunt-1' });
  client.send({ type: 'start', root: '/repo', args: ['--once'], id: 'start-1' });
  client.send({ type: 'stop', root: '/repo', after: 'later' as never, id: 'stop-1' });
  client.send({ type: 'refresh', root: '/other', id: 'refresh-1' });
  const errors: WorkerMessage[] = [];
  for (let count = 0; count < 4; count += 1) {
    errors.push(await client.next((value) => value.type === 'error'));
  }
  assert.deepEqual(errors, [
    { type: 'error', root: '/repo', message: 'no run is going in this repository', id: 'hunt-1' },
    { type: 'error', root: '/repo', message: 'Unknown argument: --once', id: 'start-1' },
    { type: 'error', root: '/repo', message: 'stop does not take --after later', id: 'stop-1' },
    { type: 'error', root: '/other', message: 'the worker serves /repo only', id: 'refresh-1' },
  ]);
});

test('a client that starts a run with a command or a flag that start does not take gets an error and no run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  for (const [args, message] of [
    [['init'], 'start does not take init'],
    [['start'], 'start does not take start'],
    [['--once'], 'Unknown argument: --once'],
    [['--json'], 'Unknown argument: --json'],
    [['--max', '1'], 'Unknown argument: --max'],
    [['--reset'], 'Unknown argument: --reset'],
    [['--verbose'], 'Unknown argument: --verbose'],
    [['--quiet'], 'Unknown argument: --quiet'],
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

const AFTER = { type: 'refresh', root: '/other', id: 'after' } as const;

const AFTER_ERROR = {
  type: 'error',
  root: '/other',
  message: 'the worker serves /repo only',
  id: 'after',
};

const answered = (value: WorkerMessage) => value.type === 'error' && value.id === 'after';

test('a client that asks a waiting watch run to refresh wakes its wait, and the run goes on', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  const controls = fake.controls();
  const refreshed = controls.refreshed!();
  const asleep = controls.interrupts.sleep(60_000, undefined, refreshed);
  client.send({ type: 'refresh', root: '/repo' });
  assert.equal(await asleep, false);
  assert.equal(refreshed.aborted, true);
  assert.equal(controls.interrupts.afterIssue(), false);
  const another = await connect(t, socketPath);
  const runs = await another.next(runsOf);
  assert.equal(runs.type === 'runs' && runs.runs['/repo']?.status, 'running');
});

test('a client that asks a stopping run to refresh changes nothing and the run still stops', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  client.send({ type: 'stop', root: '/repo' });
  await client.next(stopping);
  const refreshed = fake.controls().refreshed!();
  client.send({ type: 'refresh', root: '/repo' });
  client.send(AFTER);
  await client.next(answered);
  assert.equal(refreshed.aborted, false);
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  fake.finish();
  await client.next(stoppedRun);
});

test('a client that asks for a refresh with no run going gets no error and no run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'refresh', root: '/repo' });
  client.send(AFTER);
  assert.deepEqual(await client.next((value) => value.type === 'error'), AFTER_ERROR);
  assert.equal(fake.calls.length, 0);
});

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

test('a client that stops a run whose read of the open issues then fails sees the run end as failed with the error', async (t) => {
  const { fake, client } = await startedRun(t);
  client.send({ type: 'stop', root: '/repo' });
  await client.next(stopping);
  fake.controls().onEvent!({
    kind: 'issues.fail',
    error: 'gh failed',
    ts: '2026-11-02T10:00:00.000Z',
  });
  fake.finish(1);
  const ended = await client.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.status !== 'stopping',
  );
  assert.equal(ended.type === 'runs' && ended.runs['/repo']?.status, 'failed');
  assert.equal(ended.type === 'runs' && ended.runs['/repo']?.error, 'gh failed');
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

test('a client that sends start, stop or hunt for another repository gets an error and no run starts or stops', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  for (const value of [
    { type: 'start', root: '/repo/' },
    { type: 'stop', root: '/other', after: 'now' },
    { type: 'hunt', root: '/other', on: true },
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
});

test('a client that sends a malformed message gets no reply, no run starts and the worker keeps answering', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  for (const value of [
    null,
    42,
    [],
    {},
    { type: 5 },
    { type: 'start' },
    { type: 'start', root: 5 },
    { type: 'start', root: '/repo', args: '--hunt' },
    { type: 'start', root: '/repo', args: [1] },
    { type: 'stop' },
    { type: 'refresh' },
    { type: 'refresh', root: '/repo', id: 5 },
    { type: 'hunt', root: '/repo' },
    { type: 'hunt', root: '/repo', on: 'yes' },
    { type: 'watch', root: '/repo' },
    { type: 'watch', root: '/repo', on: 'yes' },
  ]) {
    client.send(value as never);
  }
  client.send(AFTER);
  assert.deepEqual(await client.next((value) => value.type === 'error'), AFTER_ERROR);
  assert.equal(fake.calls.length, 0);
  const another = await connect(t, socketPath);
  assert.deepEqual(await another.next(runsOf), { type: 'runs', runs: {} });
});

test('a client that asks for the questions or the upcoming issues gets no reply, as for any unknown message, and the worker keeps answering', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  const client = await connect(t, socketPath);
  for (const type of ['questions', 'upcoming', 'unknown']) {
    client.send({ type, root: '/repo' } as never);
  }
  client.send(AFTER);
  assert.deepEqual(
    await client.next((value) => value.type !== 'hello' && value.type !== 'runs'),
    AFTER_ERROR,
  );
});

async function sendMalformedFrame(socketPath: string): Promise<void> {
  const raw = createConnection(socketPath);
  const closed = new Promise<void>((resolve) => raw.on('close', () => resolve()));
  raw.on('error', () => {});
  raw.once('connect', () => {
    raw.write(
      'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  });
  raw.once('data', () => {
    raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  });
  await closed;
}

test('a client that sends a malformed frame loses its connection while the worker keeps its run going and answers other clients', async (t) => {
  const { fake, socketPath } = await startedRun(t);
  await sendMalformedFrame(socketPath);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const another = await connect(t, socketPath);
  const runs = await another.next(runsOf);
  assert.equal(runs.type === 'runs' && runs.runs['/repo']?.status, 'running');
  assert.equal(fake.controls().interrupts.afterIssue(), false);
});

test('a client that sends a hello with no version or a version that is not a string gets an error that names the version', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  const client = await connect(t, socketPath);
  for (const hello of [{ type: 'hello' }, { type: 'hello', version: 5 }]) {
    client.send(hello as never);
    const reply = await client.next((value) => value.type === 'error');
    assert.deepEqual(reply, {
      type: 'error',
      root: '/repo',
      message: 'a hello message needs its version as a string',
    });
  }
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
      lockWaitMs: 0,
    }),
    undefined,
  );
});

test('a worker does not start while the lock holds only the process id of a live process', async (t) => {
  const dir = await tempDir();
  const lockPath = join(dir, 'w.lock');
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await writeFile(lockPath, `${other.pid}\n`);
  assert.equal(
    await startWorker({
      root: '/repo',
      socketPath: join(dir, 'w.sock'),
      lockPath,
      version: '2.0.0',
      runRepo: fakeRuns().runRepo,
      lockWaitMs: 0,
    }),
    undefined,
  );
  assert.equal(await readFile(lockPath, 'utf8'), `${other.pid}\n`);
});

test('a worker started while the last one closes takes the lock once it is released', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  await writeFile(lockPath, `${process.pid} ${await processStart(process.pid)}\n`);
  setTimeout(() => void rm(lockPath, { force: true }), 100);
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
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
    idleMs: 50,
  });
  assert.ok(started);
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a client that sends an HTTP request to the worker gets 426 Upgrade Required and no next-issue answer', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  assert.deepEqual(await http(socketPath, 'GET'), { status: 426, body: 'Upgrade Required' });
  assert.deepEqual(
    await http(socketPath, 'POST', JSON.stringify({ type: 'start', root: '/repo' })),
    {
      status: 426,
      body: 'Upgrade Required',
    },
  );
});

test('a worker that gets HTTP requests and no client connection closes after the idle time', async () => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    idleMs: 200,
  });
  assert.ok(started);
  let closed = false;
  void started.closed.then(() => {
    closed = true;
  });
  for (let count = 0; count < 20 && !closed; count += 1) {
    await http(socketPath, 'GET').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(closed, true);
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
  });
  assert.ok(started);
  t.after(() => started.close());
  await connect(t, socketPath);
});

async function startTogetherInProcess(
  t: TestContext,
  dir: string,
  count: number,
): Promise<PromiseSettledResult<unknown>[]> {
  const results = await Promise.allSettled(
    Array.from({ length: count }, () =>
      startWorker({
        root: '/repo',
        socketPath: join(dir, 'w.sock'),
        lockPath: join(dir, 'w.lock'),
        version: '2.0.0',
        runRepo: fakeRuns().runRepo,
        lockWaitMs: 0,
      }),
    ),
  );
  t.after(() =>
    Promise.all(
      results.map((result) => (result.status === 'fulfilled' ? result.value?.close() : undefined)),
    ),
  );
  return results;
}

function outcomes(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .map((result) =>
      result.status === 'rejected'
        ? `failed: ${String(result.reason)}`
        : result.value === undefined
          ? 'refused'
          : 'started',
    )
    .sort();
}

test('workers that start together while a dead worker left its lock end with one worker that listens', async (t) => {
  const dir = await tempDir();
  await writeFile(join(dir, 'w.lock'), '999999999 Thu Jan  1 00:00:00 1970\n');
  const results = await startTogetherInProcess(t, dir, 8);
  assert.deepEqual(outcomes(results), [...Array(7).fill('refused'), 'started']);
  await connect(t, join(dir, 'w.sock'));
});

test('workers that start together with no lock file end with one worker that listens', async (t) => {
  const dir = await tempDir();
  const results = await startTogetherInProcess(t, dir, 8);
  assert.deepEqual(outcomes(results), [...Array(7).fill('refused'), 'started']);
  await connect(t, join(dir, 'w.sock'));
});

test('a worker that reads the lock file while another worker takes the lock never finds it empty', async () => {
  const lockPath = join(await tempDir(), 'w.lock');
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await rm(lockPath, { force: true });
    let done = false;
    const taking = lock(lockPath, 0).finally(() => {
      done = true;
    });
    while (!done) {
      seen.add(await readFile(lockPath, 'utf8').catch(() => 'missing'));
    }
    await taking;
  }
  assert.equal(seen.has(''), false);
});

test('a worker that closes leaves the socket and lock files that another worker owns', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
  });
  assert.ok(started);
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  const otherLock = `${other.pid} ${await processStart(other.pid!)}\n`;
  await rm(lockPath);
  await writeFile(lockPath, otherLock);
  await rm(socketPath);
  await writeFile(socketPath, '');
  await started.close();
  assert.equal(await readFile(lockPath, 'utf8'), otherLock);
  assert.ok(await stat(socketPath));
});

function exists(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function withFs(t: TestContext, mocks: Record<string, (...args: never[]) => unknown>) {
  for (const [name, implementation] of Object.entries(mocks)) {
    t.mock.method(fsPromises, name as keyof typeof fsPromises, implementation as never);
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('a worker that breaks a stale lock keeps the lock file that another worker links after it finds none', async (t) => {
  const lockPath = join(await tempDir(), 'w.lock');
  const otherLock = `${process.pid} ${await processStart(process.pid)}\n`;
  const realLink = fsPromises.link;
  const realOpen = fsPromises.open;
  let refused = false;
  let taken = false;
  await withFs(t, {
    link: async (source: string, target: string) => {
      if (target === lockPath && !refused) {
        refused = true;
        throw exists('EEXIST');
      }
      return realLink(source, target);
    },
    open: async (path: string, flags: string) => {
      const file = await realOpen(path, flags).catch(() => undefined);
      if (path === lockPath && file === undefined && !taken) {
        taken = true;
        await writeFile(lockPath, otherLock, { flag: 'wx' });
      }
      return file ?? Promise.reject(exists('ENOENT'));
    },
  });
  assert.equal(await lock(lockPath, 0), undefined);
  assert.equal(await readFile(lockPath, 'utf8'), otherLock);
});

test('a worker whose break file link fails keeps the break file that another worker takes after it finds none', async (t) => {
  const lockPath = join(await tempDir(), 'w.lock');
  const breakPath = `${lockPath}.break`;
  await writeFile(lockPath, '999999999 Thu Jan  1 00:00:00 1970\n');
  const otherBreak = `${process.pid} ${await processStart(process.pid)}\n`;
  const realLink = fsPromises.link;
  const realOpen = fsPromises.open;
  let refused = false;
  let taken = false;
  let breakReads = 0;
  let readTwice = (): void => undefined;
  const heldTwice = new Promise<void>((resolve) => {
    readTwice = resolve;
  });
  await withFs(t, {
    link: async (source: string, target: string) => {
      if (target === breakPath && !refused) {
        refused = true;
        throw exists('EEXIST');
      }
      return realLink(source, target);
    },
    open: async (path: string, flags: string) => {
      const file = await realOpen(path, flags).catch(() => undefined);
      if (path === breakPath && file === undefined && !taken) {
        taken = true;
        await writeFile(breakPath, otherBreak, { flag: 'wx' });
      }
      if (path === breakPath && file !== undefined && (breakReads += 1) === 2) {
        readTwice();
      }
      return file ?? Promise.reject(exists('ENOENT'));
    },
  });
  const taking = lock(lockPath, 0);
  await heldTwice;
  assert.equal(await readFile(breakPath, 'utf8').catch(() => 'missing'), otherBreak);
  await rm(breakPath);
  assert.ok(await taking);
});

test('a worker takes over an empty lock file that a worker which crashed while writing it left', async () => {
  const lockPath = join(await tempDir(), 'w.lock');
  await writeFile(lockPath, '');
  const taking = lock(lockPath, 0);
  const timeout = new Promise((resolve) => setTimeout(resolve, 2000, 'still waiting'));
  const result = await Promise.race([taking, timeout]);
  assert.notEqual(result, 'still waiting');
  assert.ok(result);
  assert.equal(
    await readFile(lockPath, 'utf8'),
    `${process.pid} ${await processStart(process.pid)}\n`,
  );
});

test('a worker that cannot read its own start time gets an error and leaves no lock file', async () => {
  const lockPath = join(await tempDir(), 'w.lock');
  await assert.rejects(
    lock(lockPath, 0, async () => undefined),
    {
      message: 'next-issue: cannot read the start time of this process',
    },
  );
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('a worker takes over the lock when its process id now belongs to a process that is not a worker', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  const other = spawn('sleep', ['30']);
  t.after(() => other.kill('SIGKILL'));
  await writeFile(lockPath, `${other.pid} Thu Jan  1 00:00:00 1970\n`);
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    lockWaitMs: 0,
  });
  assert.ok(started);
  t.after(() => started.close());
  await connect(t, socketPath);
});

async function startTogether(t: TestContext, dir: string, count: number): Promise<string[]> {
  const inner = [
    `import { startWorker } from ${JSON.stringify(SERVE)};`,
    `process.stdout.write('ready\\n');`,
    `await new Promise((resolve) => process.stdin.once('data', resolve));`,
    'const started = await startWorker({',
    `  root: '/repo',`,
    `  socketPath: ${JSON.stringify(join(dir, 'w.sock'))},`,
    `  lockPath: ${JSON.stringify(join(dir, 'w.lock'))},`,
    `  version: '2.0.0',`,
    '  runRepo: async () => 0,',
    '  lockWaitMs: 0,',
    '});',
    `process.stdout.write(started === undefined ? 'refused\\n' : 'serving\\n');`,
    'if (started === undefined) process.exit(0);',
  ].join('\n');
  const children = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', inner], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    t.after(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.setEncoding('utf8');
    const ready = new Promise<void>((resolve) =>
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.startsWith('ready\n')) {
          resolve();
        }
      }),
    );
    const result = new Promise<string>((resolve) =>
      child.stdout.on('data', () => {
        const lines = output.split('\n');
        if (lines.length > 2) {
          resolve(lines[1]!);
        }
      }),
    );
    return { child, ready, result };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) {
    child.stdin.write('go\n');
  }
  return Promise.all(children.map(({ result }) => result));
}

test('two workers that start together in one repository, with or without a stale lock, leave exactly one serving', async (t) => {
  for (const stale of [false, true, false, true, false, true, false, true]) {
    const dir = await tempDir();
    if (stale) {
      await writeFile(join(dir, 'w.lock'), '999999999 Thu Jan  1 00:00:00 1970\n');
    }
    const results = await startTogether(t, dir, 2);
    assert.deepEqual(results.sort(), ['refused', 'serving'], `stale lock: ${stale}`);
    const client = await connect(t, join(dir, 'w.sock'));
    assert.deepEqual(await client.next(runsOf), { type: 'runs', runs: {} });
  }
});

test('a worker that closes leaves a lock file that another worker in the same process took', async () => {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath,
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    idleMs: 50,
  });
  assert.ok(started);
  await writeFile(join(dir, 'other.lock'), `${process.pid} ${await processStart(process.pid)}\n`);
  await rename(join(dir, 'other.lock'), lockPath);
  await started.closed;
  assert.deepEqual(await readdir(dir), ['w.lock']);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`a worker that gets ${signal} leaves a socket and lock file that are not its own`, async (t) => {
    const root = await tempDir();
    const { socketPath, lockPath } = workerPaths(root);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { serve } from ${JSON.stringify(SERVE)}; await serve(${JSON.stringify(root)});`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    t.after(() => child.kill('SIGKILL'));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve) => {
      let output = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('listening')) {
          resolve();
        }
      });
    });
    const dir = dirname(lockPath);
    await writeFile(join(dir, 'other.sock'), '');
    await rename(join(dir, 'other.sock'), socketPath);
    await writeFile(join(dir, 'other.lock'), `${child.pid} ${await processStart(child.pid!)}\n`);
    await rename(join(dir, 'other.lock'), lockPath);
    child.kill(signal);
    await exited;
    assert.deepEqual((await readdir(dir)).sort(), ['worker.lock', 'worker.sock']);
  });
}

test('a worker removes the draft files that a dead worker left', async () => {
  const dir = await tempDir();
  const draft = join(dir, `w.lock.999999999.${randomUUID()}`);
  const guardDraft = join(dir, `w.lock.break.999999999.${randomUUID()}`);
  await writeFile(draft, '');
  await writeFile(guardDraft, '');
  await writeFile(join(dir, '~.sock'), '');
  const started = await startWorker({
    root: '/repo',
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    idleMs: 50,
  });
  assert.ok(started);
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a worker that meets a newer client closes once no run is going', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'off'] });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  client.send({ type: 'hello', version: '2.1.0' });
  client.send({ type: 'start', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'the worker is restarting, try again soon',
  });
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  fake.finish();
  await started.closed;
  await client.closed;
});

const upgrading = (value: WorkerMessage) =>
  value.type === 'runs' && value.runs['/repo']?.upgrade !== undefined;

test('a worker that meets a newer client during a watching run stops it after the running issues for an upgrade, and closes once it ends', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--hunt', 'on'] });
  await client.next(huntingIs(true));
  const controls = fake.controls();
  controls.onEvent!({ kind: 'issue.start', issue: 7, ts: '2026-11-02T10:00:00.000Z' });
  client.send({ type: 'hello', version: '2.1.0' });
  const asked = await client.next(upgrading);
  assert.equal(asked.type === 'runs' && asked.runs['/repo']!.status, 'stopping');
  assert.deepEqual(asked.type === 'runs' && asked.runs['/repo']!.upgrade, {
    from: '2.0.0',
    to: '2.1.0',
  });
  assert.equal(controls.interrupts.afterIssue(), true);
  assert.equal(controls.interrupts.afterRound(), false);
  fake.finish();
  await started.closed;
  await client.closed;
});

test('a worker that meets a newer client and then sees watching turn on stops the run after the running issues for an upgrade', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'off'] });
  await client.next(watchingIs(false));
  client.send({ type: 'hello', version: '2.1.0' });
  client.send({ type: 'watch', root: '/repo', on: true });
  await client.next(upgrading);
  assert.equal(fake.controls().interrupts.afterIssue(), true);
});

test('a person who stops a run that stops for an upgrade sees the upgrade dropped from its progress', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  client.send({ type: 'stop', root: '/repo' });
  const dropped = await client.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.upgrade === undefined,
  );
  assert.equal(dropped.type === 'runs' && dropped.runs['/repo']!.status, 'stopping');
  fake.finish();
  await started.closed;
});

test('a person who turns watching off on a run that stops for an upgrade sees the upgrade dropped from its progress', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  client.send({ type: 'watch', root: '/repo', on: false });
  const dropped = await client.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.upgrade === undefined,
  );
  assert.equal(dropped.type === 'runs' && dropped.runs['/repo']!.watching, false);
  fake.finish();
  await started.closed;
});

test('a person who turns watching off on a run that stops for an upgrade sees the run claim and work the rest of the pass', async (t) => {
  const fake = fakeRuns();
  const processed: number[] = [];
  let release: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runRepo = fake.runRepo;
  fake.runRepo = (root, args, controls) => {
    void runRepo(root, args, controls);
    return runIssues({
      issues: async () => [issue(1), issue(2)],
      process: async (target) => {
        processed.push(target.number);
        if (target.number === 1) {
          await first;
        }
        return report(target.number, 'done');
      },
      stop: controls.interrupts.afterIssue,
    }).then(() => 0);
  };
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  client.send({ type: 'watch', root: '/repo', on: false });
  await client.next(watchingIs(false));
  release();
  await client.next((value) => value.type === 'end');
  assert.deepEqual(processed, [1, 2]);
  await started.closed;
});

type PassAfterUpgrade = {
  processed: number[];
  release: (issue: number) => void;
  firstEnded: Promise<void>;
};

function passAfterUpgrade(fake: ReturnType<typeof fakeRuns>): PassAfterUpgrade {
  const processed: number[] = [];
  const gates = new Map<number, () => void>();
  const opened = new Map<number, Promise<void>>();
  for (const number of [1, 2]) {
    opened.set(number, new Promise((resolve) => gates.set(number, resolve)));
  }
  let reads = 0;
  let firstEnded: () => void = () => undefined;
  const pass: PassAfterUpgrade = {
    processed,
    release: (number) => gates.get(number)?.(),
    firstEnded: new Promise((resolve) => {
      firstEnded = resolve;
    }),
  };
  const runRepo = fake.runRepo;
  fake.runRepo = (root, args, controls) => {
    void runRepo(root, args, controls);
    return runIssues({
      issues: async () => {
        reads += 1;
        if (reads === 2) {
          firstEnded();
        }
        return [issue(1), issue(2), issue(3)];
      },
      process: async (target) => {
        processed.push(target.number);
        await opened.get(target.number);
        return report(target.number, 'done');
      },
      stop: controls.interrupts.afterIssue,
      concurrency: 2,
    }).then(() => 0);
  };
  return pass;
}

test('a person who turns watching off on a run that stops for an upgrade after one of its issues ended sees the run claim the rest of the pass and end finished', async (t) => {
  const fake = fakeRuns();
  const pass = passAfterUpgrade(fake);
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  pass.release(1);
  await pass.firstEnded;
  client.send({ type: 'watch', root: '/repo', on: false });
  await client.next(watchingIs(false));
  pass.release(2);
  const ended = await client.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.status === 'finished',
  );
  assert.equal(ended.type === 'runs' && ended.runs['/repo']!.status, 'finished');
  assert.deepEqual(pass.processed, [1, 2, 3]);
  await started.closed;
});

test('a person who stops a run that stops for an upgrade after one of its issues ended and then turns watching off sees the run claim nothing more and end stopped', async (t) => {
  const fake = fakeRuns();
  const pass = passAfterUpgrade(fake);
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  pass.release(1);
  await pass.firstEnded;
  client.send({ type: 'stop', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.upgrade === undefined);
  client.send({ type: 'watch', root: '/repo', on: false });
  await client.next(watchingIs(false));
  pass.release(2);
  await client.next(stoppedRun);
  assert.deepEqual(pass.processed, [1, 2]);
  await started.closed;
});

test('a person who stops a run that stops for an upgrade and then turns watching off sees the run still stop after the running issues', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  client.send({ type: 'stop', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.upgrade === undefined);
  client.send({ type: 'watch', root: '/repo', on: false });
  const stopping = await client.next(watchingIs(false));
  assert.equal(stopping.type === 'runs' && stopping.runs['/repo']!.status, 'stopping');
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  fake.finish();
  await started.closed;
});

test('a person who turns watching off and then on for a run that stops for an upgrade sees the run end stopped for the upgrade', async (t) => {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'] });
  await client.next(watchingIs(true));
  client.send({ type: 'hello', version: '2.1.0' });
  await client.next(upgrading);
  client.send({ type: 'watch', root: '/repo', on: false });
  await client.next(watchingIs(false));
  client.send({ type: 'watch', root: '/repo', on: true });
  const resumed = await client.next(upgrading);
  assert.equal(resumed.type === 'runs' && resumed.runs['/repo']!.watching, true);
  fake.finish();
  const ended = await client.next(stoppedRun);
  assert.deepEqual(ended.type === 'runs' && ended.runs['/repo']!.upgrade, {
    from: '2.0.0',
    to: '2.1.0',
  });
  await started.closed;
});

test('a person who turns watching or hunting on for a run they stopped gets an error with the id of the request and the run still stops', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'off'] });
  await client.next(watchingIs(false));
  client.send({ type: 'stop', root: '/repo' });
  await client.next(stopping);
  client.send({ type: 'watch', root: '/repo', on: true, id: 'watch-1' });
  client.send({ type: 'hunt', root: '/repo', on: true, id: 'hunt-1' });
  const errors: WorkerMessage[] = [];
  for (let count = 0; count < 2; count += 1) {
    errors.push(await client.next((value) => value.type === 'error'));
  }
  assert.deepEqual(errors, [
    { type: 'error', root: '/repo', message: 'the run is stopping', id: 'watch-1' },
    { type: 'error', root: '/repo', message: 'the run is stopping', id: 'hunt-1' },
  ]);
  const controls = fake.controls();
  assert.equal(controls.watching?.on(), false);
  assert.equal(controls.hunting?.on(), false);
  assert.equal(controls.interrupts.afterIssue(), true);
});

test('a client that resumes a run while a run is going gets no error and no second run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'], resume: true });
  await client.next(watchingIs(true));
  client.send({ type: 'start', root: '/repo', args: ['--watch', 'on'], resume: true });
  client.send(AFTER);
  assert.deepEqual(await client.next((value) => value.type === 'error'), AFTER_ERROR);
  assert.equal(fake.calls.length, 1);
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

test('a worker whose run ends while a client is connected sends the client the end, then closes and removes its socket and lock', async (t) => {
  const fake = fakeRuns();
  const { socketPath, dir, worker: started } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  fake.finish();
  assert.equal((await client.next((value) => value.type === 'end')).type, 'end');
  await started.closed;
  await client.closed;
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

test('a worker that runs a long time keeps only the newest whole lines of worker.log', async (t) => {
  const root = await tempDir();
  const logPath = join(root, '.next-issue', 'worker.log');
  await mkdir(dirname(logPath), { recursive: true });
  const line = `${'x'.repeat(99)}\n`;
  const old = `old ${line}`.repeat(110_000);
  await writeFile(logPath, old);
  const log = openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { serve } from ${JSON.stringify(SERVE)}; await serve(${JSON.stringify(root)}, 50);`,
    ],
    { stdio: ['ignore', log, log] },
  );
  closeSync(log);
  t.after(() => child.kill('SIGKILL'));
  const trimmed = async (first: string, last: string): Promise<string> => {
    const deadline = Date.now() + 10_000;
    let text = '';
    while (Date.now() < deadline) {
      text = await readFile(logPath, 'utf8');
      if (text.startsWith(first) && text.includes(last) && text.length <= 5 * 1024 * 1024 + 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return text;
  };
  const first = await trimmed('old ', 'listening');
  assert.ok(first.length <= 5 * 1024 * 1024 + 200, `worker.log holds ${first.length} bytes`);
  assert.match(first, /^old x+\n/);
  // A trim that fires partway through a chunked append can leave a file under the limit that never trims again,
  // so the long-running worker's log grows by one rename that the trimmer sees whole.
  await writeFile(`${logPath}.next`, `${first}${`new ${line}`.repeat(110_000)}`);
  await rename(`${logPath}.next`, logPath);
  const second = await trimmed('new ', `new ${line}`);
  assert.ok(second.length <= 5 * 1024 * 1024);
  assert.match(second, /^new x+\n/);
  assert.ok(second.endsWith(`new ${line}`));
});

test('a client of a run whose log cannot be written still sees its progress and the worker keeps answering', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const fake = fakeRuns();
  let recorder: Recorder | undefined;
  const runRepo: typeof fake.runRepo = async (root, args, controls) => {
    const dir = await tempDir();
    recorder = await Recorder.create(dir, controls.onEvent, fullDisk);
    recorder.record('issues.fail', { error: 'first' });
    return fake.runRepo(root, args, controls);
  };
  const { client, socketPath } = await startedRun(t, { ...fake, runRepo });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.error === 'first');
  await new Promise((resolve) => setTimeout(resolve, 50));
  recorder!.record('issues.fail', { error: 'second' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.error === 'second');
  const another = await connect(t, socketPath);
  await another.next((value) => value.type === 'hello');
  await recorder!.close();
  fake.finish();
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'failed');
});

test('a client of a watch run gets the summary of each pass, and a client of any other run gets none', async (t) => {
  const pass = {
    runId: 'r',
    logFile: 'l',
    roles: {},
    counts: {},
    total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    issues: [],
  };
  for (const { args, sent } of [
    { args: ['--watch', 'on'], sent: true },
    { args: ['--watch', 'off'], sent: false },
  ]) {
    const fake = fakeRuns();
    const { socketPath, worker: started } = await worker(t, fake);
    const client = await connect(t, socketPath);
    client.send({ type: 'start', root: '/repo', args });
    await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
    assert.equal(fake.controls().print !== undefined, sent);
    await fake.controls().print?.(pass);
    if (sent) {
      assert.deepEqual(await client.next((value) => value.type === 'pass'), {
        type: 'pass',
        root: '/repo',
        summary: pass,
      });
    }
    fake.finish();
    await started.close();
  }
});

test('a client that stops a run waiting between passes is told it waits, and whether a hunt is going', async (t) => {
  for (const hunting of [false, true]) {
    const { fake, client } = await startedRun(t);
    const slept = fake.controls().interrupts.sleep(60_000, () => hunting);
    client.send({ type: 'stop', root: '/repo', id: 'stop-1' });
    assert.deepEqual(await client.next((value) => value.type === 'stopping'), {
      type: 'stopping',
      root: '/repo',
      waiting: true,
      hunting,
      id: 'stop-1',
    });
    assert.equal(await slept, false);
    client.send({ type: 'stop', root: '/repo', after: 'round' });
    assert.deepEqual(await client.next((value) => value.type === 'stopping'), {
      type: 'stopping',
      root: '/repo',
      waiting: false,
      hunting: false,
    });
    fake.finish();
  }
});

async function endedResume(t: TestContext) {
  const fake = fakeRuns();
  const { socketPath, worker: started } = await worker(t, fake);
  const starter = await connect(t, socketPath);
  starter.send({ type: 'start', root: '/repo', resume: true });
  await starter.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'running');
  fake.finish(3);
  await starter.next((value) => value.type === 'end');
  return { socketPath, started };
}

test('a client that rejoins a resumed run after it ended gets the end of the run, and the worker then closes', async (t) => {
  const { socketPath, started } = await endedResume(t);
  const late = await connect(t, socketPath);
  late.send({ type: 'rejoin', root: '/repo' });
  assert.deepEqual(await late.next((value) => value.type === 'end'), {
    type: 'end',
    root: '/repo',
    code: 3,
  });
  await started.closed;
});

test('a client that starts a run while the worker holds the end of a resumed run for a rejoin gets an error that the worker is closing', async (t) => {
  const { socketPath } = await endedResume(t);
  const other = await connect(t, socketPath);
  other.send({ type: 'start', root: '/repo', id: 'late' });
  assert.deepEqual(await other.next((value) => value.type === 'error'), {
    type: 'error',
    root: '/repo',
    message: 'the worker is closing, try again soon',
    id: 'late',
  });
});
