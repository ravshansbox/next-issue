import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startWorker } from '../../next-issue/src/worker/serve.mts';
import { tempDir } from '../../next-issue/test/temp-dir.mts';
import { fakeRuns } from '../../next-issue/test/worker-harness.mts';
import { workerPaths } from '../src/paths.ts';
import { refreshRun, startRun, statusOf, stopRun, switchRun } from '../src/tools.ts';
import { WorkerClient } from '../src/worker.ts';
import { nodeHost } from './node-host.ts';

const FIXTURE = new URL('fixtures/worker.ts', import.meta.url).pathname;

async function repository(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, '.next-issue'), { recursive: true });
  return root;
}

async function listening(t: TestContext, root: string, version = '2.0.0', fake = fakeRuns()) {
  const worker = await startWorker({
    root,
    ...workerPaths(root),
    version,
    runRepo: fake.runRepo,
    questions: async () => [],
    upcoming: async () => ({ claimable: [{ issue: 3, title: 'Three' }], blocked: [] }),
  });
  assert.ok(worker);
  t.after(() => worker.close());
  return { worker, fake };
}

function client(root: string, version = '2.0.0', fail = false) {
  return new WorkerClient({
    root,
    version,
    launch: {
      command: process.execPath,
      args: [FIXTURE, root, version, ...(fail ? ['fail'] : [])],
    },
    host: nodeHost,
    startTimeoutMs: 10_000,
    holderGraceMs: 200,
    pollMs: 50,
  });
}

async function stopWorker(root: string): Promise<void> {
  const pid = Number(
    (await readFile(workerPaths(root).lockPath, 'utf8').catch(() => '')).split(' ')[0],
  );
  if (pid > 0) {
    process.kill(pid, 'SIGTERM');
  }
}

test('a person who asks for the status with no worker running is told that no worker is running', async () => {
  assert.equal(await statusOf(client(await repository())), 'no worker is running');
});

test('a person who asks for the status with no run going is told that there is no run', async (t) => {
  const root = await repository();
  await listening(t, root);
  assert.equal(await statusOf(client(root)), `no run of ${root}`);
});

test('a model that starts a run on a listening worker gets the run started', async (t) => {
  const root = await repository();
  const { fake } = await listening(t, root);
  const worker = client(root);
  assert.equal(await startRun(worker), `Started a next-issue run of ${root}.`);
  assert.equal(fake.calls.length, 1);
  assert.equal(worker.progress?.status, 'running');
  assert.equal(worker.progress?.watching, true);
});

test('a model that starts a run while one is going starts nothing and asks the going run to check for new issues', async (t) => {
  const root = await repository();
  const { fake } = await listening(t, root);
  await startRun(client(root));
  const text = await startRun(client(root));
  assert.match(
    text,
    /^A run of .* is going already, so nothing started: looking for issues\. Asked it to check for new issues now\.$/,
  );
  assert.equal(fake.calls.length, 1);
});

test('a model that starts a run with no worker running starts the worker of the plugin, then the run', async (t) => {
  const root = await repository();
  t.after(() => stopWorker(root));
  const worker = client(root);
  assert.equal(await startRun(worker), `Started a next-issue run of ${root}.`);
  assert.equal(worker.workerVersion, '2.0.0');
});

test('a model whose worker exits before it listens gets an error that points to the worker log', async () => {
  const root = await repository();
  await assert.rejects(startRun(client(root, '2.0.0', true)), {
    message: 'the next-issue worker exited before it listened (see .next-issue/worker.log)',
  });
  assert.match(await readFile(workerPaths(root).logPath, 'utf8'), /the worker failed/);
});

test('a model newer than an idle worker that starts a run gets a newer worker in its place', async (t) => {
  const root = await repository();
  const old = await listening(t, root, '2.0.0');
  t.after(() => stopWorker(root));
  const worker = client(root, '2.1.0');
  assert.equal(await startRun(worker), `Started a next-issue run of ${root}.`);
  await old.worker.closed;
  assert.equal(worker.workerVersion, '2.1.0');
  assert.equal(old.fake.calls.length, 0);
});

test('a model that switches watching or hunting with no run going gets an error', async (t) => {
  const root = await repository();
  await listening(t, root);
  await assert.rejects(switchRun(client(root), 'watch', false), {
    message: `no run of ${root} is going`,
  });
  await assert.rejects(stopRun(client(root), 'issue'), { message: `no run of ${root} is going` });
});

test('a model that switches watching off and hunting on sees the run change, with no restart', async (t) => {
  const root = await repository();
  const { fake } = await listening(t, root);
  const worker = client(root);
  await startRun(worker);
  assert.equal(await switchRun(worker, 'hunt', true), `Hunting is on for the run of ${root}.`);
  assert.equal(worker.progress?.hunting, true);
  assert.equal(
    await switchRun(worker, 'watch', false),
    `The run of ${root} ends after the current pass, with hunting off.`,
  );
  assert.equal(worker.progress?.watching, false);
  assert.equal(worker.progress?.hunting, false);
  assert.equal(fake.calls.length, 1);
});

test('a model newer than the worker of a going run cannot switch it and is told to restart the run', async (t) => {
  const root = await repository();
  await listening(t, root, '2.0.0');
  await startRun(client(root, '2.0.0'));
  await assert.rejects(switchRun(client(root, '2.1.0'), 'hunt', true), {
    message:
      'the worker of the going run is older than this plugin, so it cannot switch hunting. Stop the run, then start it again',
  });
});

test('a model that refreshes asks only a going run that watches and is not stopping', async (t) => {
  const root = await repository();
  await listening(t, root);
  const worker = client(root);
  assert.equal(await refreshRun(worker), `No run of ${root} is going, so nothing was asked.`);
  await startRun(worker);
  assert.equal(await refreshRun(worker), `Asked the run of ${root} to check for new issues now.`);
  await switchRun(worker, 'watch', false);
  assert.equal(
    await refreshRun(worker),
    `The run of ${root} does not watch for new issues, so it would ignore the request and nothing was asked.`,
  );
  assert.equal(
    await stopRun(worker, 'round'),
    `Asked the run of ${root} to stop after the current round.`,
  );
  assert.equal(
    await refreshRun(worker),
    `The run of ${root} is stopping, so it would ignore the request and nothing was asked.`,
  );
});

test('a person who opens the upcoming issues gets those the worker would claim', async (t) => {
  const root = await repository();
  await listening(t, root);
  assert.deepEqual(await client(root).upcoming(), {
    claimable: [{ issue: 3, title: 'Three' }],
    blocked: [],
  });
});

test('a person who opens the upcoming issues with no worker running is told so', async () => {
  await assert.rejects(client(await repository()).upcoming(), {
    message: 'No worker is running, so the upcoming issues cannot be listed.',
  });
});
