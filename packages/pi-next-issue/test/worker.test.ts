import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { workerPaths } from '../src/spawn-worker.ts';
import { WorkerClient } from '../src/worker.ts';
import { running, startFakeWorker } from './fake-worker.ts';

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
