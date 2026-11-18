import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WorkerMessage } from '../src/protocol.mts';
import { startWorker } from '../src/serve.mts';
import { tempDir } from './temp-dir.mts';
import {
  connect,
  fakeRuns,
  http,
  noQuestions,
  poll,
  post,
  runsOf,
  worker,
} from './worker-harness.mts';

const runOf = (messages: WorkerMessage[]) => {
  const runs = messages.findLast(runsOf);
  return runs?.type === 'runs' ? runs.runs['/repo'] : undefined;
};

test('a client that polls the worker over HTTP gets the worker version and the runs', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  assert.deepEqual(await poll(socketPath), [
    { type: 'hello', version: '2.0.0' },
    { type: 'runs', runs: {} },
  ]);
});

test('a client that starts a run over HTTP gets the new run in the reply, and a socket client sees it too', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const watcher = await connect(t, socketPath);
  await watcher.next(runsOf);
  const reply = await post(socketPath, { type: 'start', root: '/repo', args: ['--hunt', 'on'] });
  assert.equal(runOf(reply)?.status, 'running');
  assert.equal(runOf(reply)?.hunting, true);
  assert.equal(fake.calls[0]!.args.hunt, true);
  await watcher.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  fake.controls().onEvent!({ kind: 'issue.start', issue: 7, ts: '2026-11-02T10:00:00.000Z' });
  assert.deepEqual(
    runOf(await poll(socketPath))?.issues.map((entry) => entry.issue),
    [7],
  );
});

test('a client that starts a second run over HTTP gets the refusal in the reply and no second run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  await post(socketPath, { type: 'start', root: '/repo' });
  const reply = await post(socketPath, { type: 'start', root: '/repo' });
  assert.deepEqual(reply[0], {
    type: 'error',
    root: '/repo',
    message: 'a run is going in this repository already',
  });
  assert.equal(fake.calls.length, 1);
});

test('a client that stops a run over HTTP gets the stopping answer and the stopping run in the reply', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  await post(socketPath, { type: 'start', root: '/repo' });
  const reply = await post(socketPath, { type: 'stop', root: '/repo', after: 'round' });
  assert.equal(reply[0]!.type, 'stopping');
  assert.equal(runOf(reply)?.status, 'stopping');
  assert.equal(fake.controls().interrupts.afterRound(), true);
});

test('a client that switches hunting and watching over HTTP sees them change in the reply', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  await post(socketPath, { type: 'start', root: '/repo' });
  assert.equal(
    runOf(await post(socketPath, { type: 'hunt', root: '/repo', on: true }))?.hunting,
    true,
  );
  const off = runOf(await post(socketPath, { type: 'watch', root: '/repo', on: false }));
  assert.equal(off?.watching, false);
  assert.equal(off?.hunting, false);
});

test('a client that asks for the questions over HTTP gets them in the reply', async (t) => {
  const question = {
    issue: 7,
    title: 'Seven',
    reason: 'stuck',
    url: 'https://github.com/o/r/issues/7',
    repo: 'o/r',
    labels: { needsHuman: 'needs-human', skip: 'skip' },
  };
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async () => [question]);
  const reply = await post(socketPath, { type: 'questions', root: '/repo' });
  assert.deepEqual(reply[0], { type: 'questions', root: '/repo', questions: [question] });
});

test('a client that asks for the upcoming issues over HTTP gets them in the reply', async (t) => {
  const upcoming = { claimable: [{ issue: 3, title: 'Three' }], blocked: [] };
  const { socketPath } = await worker(
    t,
    fakeRuns(),
    '2.0.0',
    noQuestions,
    undefined,
    async () => upcoming,
  );
  const reply = await post(socketPath, { type: 'upcoming', root: '/repo' });
  assert.deepEqual(reply[0], { type: 'upcoming', root: '/repo', ...upcoming });
});

test('a client that posts a malformed message over HTTP gets a 400 with an error and no run starts', async (t) => {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  for (const body of ['not json', '{"type":"start"}', '[]']) {
    const reply = await http(socketPath, 'POST', body);
    assert.equal(reply.status, 400);
    assert.deepEqual(JSON.parse(reply.body), [
      { type: 'error', root: '/repo', message: 'the request is not a next-issue message' },
    ]);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal((await poll(socketPath)).length, 2);
});

test('a client that asks for another path or method over HTTP gets a 404 or a 405', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  assert.equal((await http(socketPath, 'GET', undefined, '/other')).status, 404);
  assert.equal((await http(socketPath, 'DELETE')).status, 405);
});

async function idleWorker(idleMs: number) {
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo: fakeRuns().runRepo,
    questions: noQuestions,
    idleMs,
  });
  assert.ok(started);
  return { dir, socketPath, started };
}

test('a worker that a client polls over HTTP stays open, and closes once the polls stop for the idle time', async () => {
  const { dir, socketPath, started } = await idleWorker(200);
  let closed = false;
  void started.closed.then(() => {
    closed = true;
  });
  for (let count = 0; count < 8; count += 1) {
    await poll(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  assert.equal(closed, false);
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a worker whose run ends after the last HTTP poll closes once the idle time has passed', async () => {
  const fake = fakeRuns();
  const dir = await tempDir();
  const socketPath = join(dir, 'w.sock');
  const started = await startWorker({
    root: '/repo',
    socketPath,
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo: fake.runRepo,
    questions: noQuestions,
    idleMs: 200,
  });
  assert.ok(started);
  await post(socketPath, { type: 'start', root: '/repo' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  fake.finish();
  await started.closed;
  assert.deepEqual(await readdir(dir), []);
});

test('a worker that gets a newer hello over HTTP with no run going closes', async () => {
  const { socketPath, started } = await idleWorker(60_000);
  const reply = await post(socketPath, { type: 'hello', version: '2.1.0' });
  assert.deepEqual(reply, [{ type: 'runs', runs: {} }]);
  await started.closed;
});
