import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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
