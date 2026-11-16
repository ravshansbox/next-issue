import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { workerPaths } from '../src/spawn-worker.ts';
import { WorkerClient, type WorkerEvent } from '../src/worker.ts';
import { type FakeWorker, running, socketPath, startFakeWorker, until } from './fake-worker.ts';

async function connectsIn(t: test.TestContext, name: string): Promise<void> {
  const root = join(mkdtempSync('/tmp/pi-next-issue-'), name);
  const { socketPath } = workerPaths(root);
  mkdirSync(join(root, '.next-issue'), { recursive: true });
  const worker = await startFakeWorker(socketPath);
  t.after(() => worker.close());
  worker.runs[root] = running();
  const spawns: string[] = [];
  const client = new WorkerClient({
    socketPath,
    version: '1.0.0',
    spawnWorker: (version) => spawns.push(version),
    startTimeoutMs: 500,
  });
  t.after(() => client.close());
  await client.ensure();
  assert.equal(client.connected, true);
  assert.deepEqual(client.runs, { [root]: running() });
  assert.deepEqual(spawns, []);
}

test('a client in a repository whose path holds a space and a non-ASCII letter connects to its worker and gets the runs', async (t) => {
  await connectsIn(t, 'My Проекты app');
});

test('a client in a repository whose path holds #, ? and : connects to its worker and gets the runs', async (t) => {
  await connectsIn(t, 'a#b?c:d');
});

test('several pi sessions with a newer extension whose watching run stops for an upgrade each ask the newer worker to resume the run, which it may refuse with no error shown', async (t) => {
  const path = socketPath();
  const old = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'hello' && message.version === '2.0.0') {
      self.update('/repo', {
        ...self.runs['/repo']!,
        status: 'stopping',
        upgrade: { from: '1.0.0', to: '2.0.0' },
      });
    }
  });
  old.runs['/repo'] = running({ watching: true });
  let fresh: Promise<FakeWorker> | undefined;
  const spawnWorker = () => {
    fresh ??= startFakeWorker(path, '2.0.0', (self, message) => {
      if (message.type !== 'start') {
        return;
      }
      if (self.runs['/repo']?.status !== 'running') {
        self.update('/repo', running({ watching: true }));
      } else if (message.resume !== true) {
        self.reply({ type: 'error', root: '/repo', message: 'a run is going' });
      }
    });
  };
  const events: WorkerEvent[] = [];
  const clients = [0, 1].map(() => {
    const client = new WorkerClient({
      socketPath: path,
      version: '2.0.0',
      spawnWorker,
      startTimeoutMs: 2000,
      reconnectMs: 50,
    });
    client.subscribe((event) => events.push(event));
    t.after(() => client.close());
    return client;
  });
  await Promise.all(clients.map((client) => client.attach()));
  await until(() => clients.every((client) => client.runs['/repo']?.upgrade !== undefined));
  await old.close();
  await until(() => clients.every((client) => client.runs['/repo']?.status === 'running'));
  const started = await fresh!;
  t.after(() => started.close());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const starts = started.received.filter((message) => message.type === 'start');
  assert.ok(starts.length > 0);
  assert.ok(starts.every((message) => message.type === 'start' && message.resume === true));
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('a pi session that attaches, reaches and ensures the worker at the same time opens one connection to it', async (t) => {
  const path = socketPath();
  const worker = await startFakeWorker(path);
  t.after(() => worker.close());
  const client = new WorkerClient({
    socketPath: path,
    version: '1.0.0',
    spawnWorker: () => {},
    startTimeoutMs: 500,
  });
  t.after(() => client.close());
  await Promise.all([client.attach(), client.reach(), client.ensure(), client.attach()]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.connected, true);
  assert.equal(worker.connections, 1);
});

test('a pi tool call to a worker that accepts the connection but never answers fails with an error that says the worker did not answer', async (t) => {
  const path = socketPath();
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new WorkerClient({
    socketPath: path,
    version: '1.0.0',
    spawnWorker: () => {},
    startTimeoutMs: 5000,
    answerTimeoutMs: 200,
  });
  t.after(() => client.close());
  await assert.rejects(client.ensure(), { message: 'the next-issue worker did not answer' });
  await assert.rejects(client.reach(), { message: 'the next-issue worker did not answer' });
});

test('a pi tool call that reconnects while the worker has not finished closing the earlier connection closes that earlier connection', async (t) => {
  const path = socketPath();
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const raws: Socket[] = [];
  server.on('upgrade', (request, raw: Socket, head) => {
    sockets.handleUpgrade(request, raw, head, (socket) => {
      raws.push(raw);
      socket.send(JSON.stringify({ type: 'hello', version: '1.0.0' }));
      socket.send(JSON.stringify({ type: 'runs', runs: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(async () => {
    for (const raw of raws) {
      raw.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new WorkerClient({
    socketPath: path,
    version: '1.0.0',
    spawnWorker: () => {},
    startTimeoutMs: 500,
  });
  t.after(() => client.close());
  await client.reach();
  const earlier = raws[0]!;
  earlier.pause();
  earlier.write(Buffer.from([0x88, 0x00]));
  await until(() => !client.connected);
  await client.reach();
  assert.equal(raws.length, 2);
  const written = await new Promise<Error | null | undefined>((resolve) => {
    earlier.once('error', () => {});
    earlier.write(Buffer.from([0x89, 0x00]), resolve);
  });
  assert.ok(written instanceof Error);
});
