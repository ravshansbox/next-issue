import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { hasCode } from '../src/shared/errors.mts';
import { lockHolder } from '../src/shared/lock.mts';
import type { WorkerMessage } from '../src/shared/protocol.mts';
import { startWorker } from '../src/worker/serve.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRegistry, fakeRuns, worker } from './worker-harness.mts';

const SUCCESSOR = new URL('successor-worker.mts', import.meta.url).pathname;

async function oldWorker(
  t: TestContext,
  options: Pick<Parameters<typeof startWorker>[0], 'registry' | 'successorLaunch'> = {},
) {
  const root = await realpath(await tempDir('/tmp'));
  const { logPath: _logPath, ...paths } = workerPaths(root);
  const fake = fakeRuns();
  const started = await startWorker({
    root,
    ...paths,
    version: '2.0.0',
    runRepo: fake.runRepo,
    ...options,
  });
  assert.ok(started);
  t.after(async () => {
    await started.close();
    const holder = await lockHolder(paths.lockPath);
    if (holder !== undefined && holder !== process.pid) {
      try {
        process.kill(holder, 'SIGKILL');
      } catch (error) {
        if (!hasCode(error, 'ESRCH')) {
          throw error;
        }
      }
    }
  });
  return { root, fake, started, socketPath: paths.socketPath };
}

const runOf = (root: string, value: WorkerMessage) =>
  value.type === 'runs' ? value.runs[root] : undefined;

test('a watching run that stops for a newer client comes back on the newer worker with its watching and hunting settings, after the client that said hello has gone', async (t) => {
  const { root, fake, started, socketPath } = await oldWorker(t);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--hunt', 'on'] });
  await client.next((value) => runOf(root, value)?.hunting === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: process.execPath, args: [SUCCESSOR] },
  });
  const asked = await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  assert.deepEqual(runOf(root, asked)?.upgrade, { from: '2.0.0', to: '2.1.0', resumes: true });
  await client.close();
  fake.finish();
  await started.closed;
  const fresh = await connect(t, socketPath);
  assert.deepEqual(await fresh.next((value) => value.type === 'hello'), {
    type: 'hello',
    version: '2.1.0',
  });
  const resumed = runOf(root, await fresh.next((value) => value.type === 'runs'));
  assert.equal(resumed?.status, 'running');
  assert.equal(resumed?.watching, true);
  assert.equal(resumed?.hunting, true);
  fresh.send({ type: 'stop', root });
  await fresh.next((value) => runOf(root, value)?.status === 'stopped');
});

test('a person whose watching run stops for a newer client sees it come back on a newer worker that starts listening only after 31 seconds', async (t) => {
  const { root, fake, started, socketPath } = await oldWorker(t);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.watching === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: process.execPath, args: [SUCCESSOR, '2.1.0', '0', '31000'] },
  });
  await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  await client.close();
  fake.finish();
  await started.closed;
  const fresh = await connect(t, socketPath);
  const resumed = runOf(root, await fresh.next((value) => value.type === 'runs'));
  assert.equal(resumed?.status, 'running');
  assert.equal(resumed?.watching, true);
  fresh.send({ type: 'stop', root });
  await fresh.next((value) => runOf(root, value)?.status === 'stopped');
});

test('a client of a watching run whose worker cannot start the newer worker sees the run fail with the reason', async (t) => {
  const { root, fake, started, socketPath } = await oldWorker(t);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.watching === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: join(root, 'missing'), args: ['serve'] },
  });
  await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  fake.finish();
  const failed = runOf(root, await client.next((value) => runOf(root, value)?.status === 'failed'));
  assert.match(
    failed?.error ?? '',
    /^the worker could not start next-issue 2\.1\.0: the next-issue worker exited before it listened: .*ENOENT/,
  );
  await started.closed;
  await client.closed;
});

test('a client of a watching run that fails while it stops for a newer client sees the run fail, and no newer worker starts it again', async (t) => {
  const { root, fake, started, socketPath } = await oldWorker(t);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.watching === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: process.execPath, args: [SUCCESSOR] },
  });
  await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  fake.controls().onEvent!({
    kind: 'issues.fail',
    error: 'gh failed',
    ts: '2026-11-02T10:00:00.000Z',
  });
  fake.finish(1);
  const ended = runOf(
    root,
    await client.next((value) => runOf(root, value)?.status !== 'stopping'),
  );
  assert.equal(ended?.status, 'failed');
  assert.equal(ended?.error, 'gh failed');
  await started.closed;
  await client.closed;
  assert.equal(await lockHolder(workerPaths(root).lockPath), undefined);
});

test('a client that says hello with a malformed way to start the worker gets an error that names it', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  const client = await connect(t, socketPath);
  for (const launch of [{ command: 5, args: [] }, { command: 'npx' }, 'npx']) {
    client.send({ type: 'hello', version: '2.1.0', launch } as never);
    assert.deepEqual(await client.next((value) => value.type === 'error'), {
      type: 'error',
      root: '/repo',
      message: 'a hello message needs its launch as a command and a list of args',
    });
  }
});

test('a run with watching off that stops because npm serves a newer next-issue comes back on the newer worker with watching and hunting off', async (t) => {
  const registry = await fakeRegistry(t, { version: '2.1.0' });
  const { root, fake, started, socketPath } = await oldWorker(t, {
    registry: registry.url,
    successorLaunch: (version) => ({ command: process.execPath, args: [SUCCESSOR, version] }),
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  await client.next((value) => runOf(root, value)?.status === 'running');
  await fake.controls().beforeClaim?.();
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  fake.finish();
  await started.closed;
  const fresh = await connect(t, socketPath);
  assert.deepEqual(await fresh.next((value) => value.type === 'hello'), {
    type: 'hello',
    version: '2.1.0',
  });
  const resumed = runOf(root, await fresh.next((value) => value.type === 'runs'));
  assert.equal(resumed?.watching, false);
  assert.equal(resumed?.hunting, false);
  fresh.send({ type: 'rejoin', root });
  await fresh.next((value) => value.type === 'end');
});
