import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode } from '../src/shared/errors.mts';
import { lockHolder } from '../src/shared/lock.mts';
import type { WorkerMessage } from '../src/shared/protocol.mts';
import { startWorker } from '../src/worker/serve.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';
import { LOG_LIMIT_BYTES, trimLog } from '../src/worker/worker-log.mts';
import { watchIssues } from '../src/shared/watch.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRegistry, fakeRuns, versionCheck, worker } from './worker-harness.mts';

const SUCCESSOR = new URL('successor-worker.mts', import.meta.url).pathname;

async function oldWorker(
  t: TestContext,
  options: Pick<
    Parameters<typeof startWorker>[0],
    'registry' | 'successorLaunch' | 'log' | 'versionCheck'
  > = {},
) {
  const root = await realpath(await tempDir('/tmp'));
  const { logPath: _logPath, ...paths } = workerPaths(root);
  const fake = fakeRuns();
  const started = await startWorker({
    root,
    ...paths,
    version: '2.0.0',
    runRepo: (root, args, controls) => fake.runRepo(root, args, controls),
    versionCheck: versionCheck(0),
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

test('a worker that hands its watching run over to a newer worker writes worker.exit with reason hand-over and code 0', async (t) => {
  let log = '';
  const { root, fake, started, socketPath } = await oldWorker(t, { log: (text) => (log += text) });
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.watching === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: process.execPath, args: [SUCCESSOR] },
  });
  await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  await client.close();
  fake.finish();
  await started.closed;
  assert.match(log, /^\d\d:\d\d:\d\d worker\.exit reason=hand-over code=0\n$/m);
  const fresh = await connect(t, socketPath);
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

test('a worker that cannot start the newer worker writes worker.exit with reason hand-over-failed, code 1 and the error, and closes with code 1', async (t) => {
  let log = '';
  const { root, fake, started, socketPath } = await oldWorker(t, { log: (text) => (log += text) });
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
  assert.equal(await started.closed, 1);
  assert.match(
    log,
    /^\d\d:\d\d:\d\d worker\.exit reason=hand-over-failed code=1 error=the worker could not start next-issue 2\.1\.0: .*\n$/m,
  );
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

test('a run with watching off that stops because npm serves a newer next-issue that npx can run comes back on the newer worker with watching and hunting off', async (t) => {
  const registry = await fakeRegistry(t, { version: '2.1.0' });
  const checked: string[] = [];
  const { root, fake, started, socketPath } = await oldWorker(t, {
    registry: registry.url,
    successorLaunch: (version) => ({ command: process.execPath, args: [SUCCESSOR, version] }),
    versionCheck: versionCheck(0, checked),
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  await client.next((value) => runOf(root, value)?.status === 'running');
  await fake.controls().beforeClaim?.();
  assert.equal(fake.controls().interrupts.afterIssue(), true);
  assert.deepEqual(checked, ['2.1.0']);
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
  fresh.send({ type: 'stop', root });
  await fresh.next((value) => value.type === 'end');
});

test('a run that is about to claim an issue while npm serves a newer next-issue that npx cannot run yet goes on without an upgrade, the worker says it stays on its version and checks again before the issue after', async (t) => {
  let log = '';
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const registry = await fakeRegistry(t, { version: '2.1.0' });
  const checked: string[] = [];
  const { root, fake, started, socketPath } = await oldWorker(t, {
    registry: registry.url,
    successorLaunch: (version) => ({ command: process.execPath, args: [SUCCESSOR, version] }),
    versionCheck: versionCheck(1, checked),
    log: (text) => (log += text),
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.status === 'running');
  await fake.controls().beforeClaim?.();
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  await fake.controls().beforeClaim?.();
  assert.equal(fake.controls().interrupts.afterIssue(), false);
  assert.deepEqual(checked, ['2.1.0', '2.1.0']);
  const stays = written.filter((line) => line.startsWith('the worker stays on next-issue '));
  assert.equal(stays.length, 2);
  for (const line of stays) {
    assert.match(line, /^the worker stays on next-issue 2\.0\.0: .+\n$/);
  }
  await client.close();
  fake.finish();
  await started.closed;
  assert.match(log, /^\d\d:\d\d:\d\d worker\.exit reason=idle code=0\n$/m);
});

test('a worker that starts a newer worker leaves worker.log whole, so it keeps the lines the newer worker appends meanwhile', async (t) => {
  const { root, fake, started, socketPath } = await oldWorker(t);
  const { logPath } = workerPaths(root);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'on'] });
  await client.next((value) => runOf(root, value)?.watching === true);
  client.send({
    type: 'hello',
    version: '2.1.0',
    launch: { command: process.execPath, args: [SUCCESSOR, '2.1.0', '0', '500'] },
  });
  await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  await client.close();
  fake.finish();
  while (existsSync(socketPath)) {
    await delay(5);
  }
  const line = `${'x'.repeat(99)}\n`;
  await appendFile(logPath, line.repeat(LOG_LIMIT_BYTES / line.length + 10));
  const before = (await stat(logPath)).size;
  let handedOver = false;
  void started.closed.then(() => (handedOver = true));
  while (!handedOver) {
    trimLog(logPath);
    await delay(10);
  }
  assert.ok((await stat(logPath)).size >= before, 'worker.log was cut during the hand-over');
  const fresh = await connect(t, socketPath);
  fresh.send({ type: 'stop', root });
  await fresh.next((value) => runOf(root, value)?.status === 'stopped');
});

function huntingRun(fake: ReturnType<typeof fakeRuns>): {
  hunts: () => number;
  hunted: Promise<void>;
} {
  let hunts = 0;
  let hunted: () => void = () => undefined;
  const firstHunt = new Promise<void>((resolve) => {
    hunted = resolve;
  });
  const runRepo = fake.runRepo;
  fake.runRepo = (root, args, controls) => {
    void runRepo(root, args, controls);
    return watchIssues({
      issues: async () => [],
      process: async () => {
        throw new Error('no issue to process');
      },
      stop: controls.interrupts.afterIssue,
      wait: (minutes, woken) => controls.interrupts.sleep(minutes * 60_000, woken),
      passEnd: async () => undefined,
      unreadable: () => undefined,
      hunter: {
        cap: 1,
        ready: async () => [],
        hunt: async () => {
          hunts += 1;
          hunted();
          return false;
        },
        wait: (_minutes, signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
      },
      hunting: controls.hunting,
      watching: controls.watching,
      beforeHunt: controls.beforeHunt,
    }).then(() => 0);
  };
  return { hunts: () => hunts, hunted: firstHunt };
}

test('a hunting run with no ready issues that is about to hunt while npm serves a newer next-issue starts no hunt, stops for an upgrade that resumes, and comes back on the newer worker with hunting on', async (t) => {
  const registry = await fakeRegistry(t, { version: '2.1.0' });
  const { root, fake, started, socketPath } = await oldWorker(t, {
    registry: registry.url,
    successorLaunch: (version) => ({ command: process.execPath, args: [SUCCESSOR, version] }),
  });
  const run = huntingRun(fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--hunt', 'on'] });
  const asked = await client.next((value) => runOf(root, value)?.upgrade !== undefined);
  assert.deepEqual(runOf(root, asked)?.upgrade, { from: '2.0.0', to: '2.1.0', resumes: true });
  await client.close();
  await started.closed;
  assert.equal(run.hunts(), 0);
  const fresh = await connect(t, socketPath);
  assert.deepEqual(await fresh.next((value) => value.type === 'hello'), {
    type: 'hello',
    version: '2.1.0',
  });
  const resumed = runOf(root, await fresh.next((value) => value.type === 'runs'));
  assert.equal(resumed?.status, 'running');
  assert.equal(resumed?.hunting, true);
  fresh.send({ type: 'stop', root });
  await fresh.next((value) => runOf(root, value)?.status === 'stopped');
});

for (const [answer, what] of [
  [{ version: '2.0.0' }, 'the same version'],
  [{ version: '1.9.0' }, 'an older version'],
  [{ status: 500 }, 'an error'],
  ['silent', 'nothing for 3 seconds'],
] as const) {
  test(`a hunting run that is about to hunt while npm answers with ${what} starts the hunt as before`, async (t) => {
    const registry = await fakeRegistry(t, answer);
    const { root, started, socketPath, fake } = await oldWorker(t, { registry: registry.url });
    const run = huntingRun(fake);
    const client = await connect(t, socketPath);
    client.send({ type: 'start', root, args: ['--hunt', 'on'] });
    await run.hunted;
    assert.equal(run.hunts(), 1);
    assert.equal(registry.asked(), 1);
    client.send({ type: 'stop', root });
    const ended = runOf(
      root,
      await client.next(
        (value) => value.type === 'runs' && runOf(root, value)?.status === 'stopped',
      ),
    );
    assert.equal(ended?.upgrade, undefined);
    await started.close();
  });
}

test('a hunting run that is about to hunt while npm cannot be reached starts the hunt as before', async (t) => {
  const { root, started, socketPath, fake } = await oldWorker(t, {
    registry: 'http://127.0.0.1:1/next-issue/latest',
  });
  const run = huntingRun(fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--hunt', 'on'] });
  await run.hunted;
  assert.equal(run.hunts(), 1);
  client.send({ type: 'stop', root });
  await client.next((value) => runOf(root, value)?.status === 'stopped');
  await started.close();
});
