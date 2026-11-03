import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Args } from '../src/args.mts';
import type { RunControls } from '../src/run.mts';
import type { ClientMessage, Question, WorkerMessage } from '../src/protocol.mts';
import { type ListQuestions, type RunRepo, startWorker } from '../src/serve.mts';

type Client = {
  send: (value: ClientMessage) => void;
  next: (match: (value: WorkerMessage) => boolean) => Promise<WorkerMessage>;
  closed: Promise<void>;
};

async function connect(t: TestContext, socketPath: string): Promise<Client> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`);
  const seen: WorkerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on('message', (data) => {
    seen.push(JSON.parse(String(data)) as WorkerMessage);
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  t.after(() => socket.terminate());
  return {
    send: (value) => socket.send(JSON.stringify(value)),
    next: async (match) => {
      for (;;) {
        const index = seen.findIndex(match);
        if (index >= 0) {
          return seen.splice(0, index + 1).at(-1)!;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    closed,
  };
}

type Fake = {
  runRepo: RunRepo;
  calls: { root: string; args: Args }[];
  controls: () => RunControls;
  finish: () => void;
};

function fakeRuns(): Fake {
  const calls: { root: string; args: Args }[] = [];
  let controls: RunControls | undefined;
  let finish: () => void = () => undefined;
  return {
    calls,
    controls: () => controls!,
    finish: () => finish(),
    runRepo: (root, args, given) => {
      calls.push({ root, args });
      controls = given;
      return new Promise((resolve) => {
        finish = () => resolve(0);
      });
    },
  };
}

const noQuestions: ListQuestions = async () => [];

async function worker(
  t: TestContext,
  fake: Fake,
  version = '2.0.0',
  questions: ListQuestions = noQuestions,
) {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const paths = {
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
    rootsPath: join(dir, 'w.roots.json'),
  };
  const started = await startWorker({ ...paths, version, runRepo: fake.runRepo, questions });
  assert.ok(started);
  t.after(() => started.close());
  return { ...paths, worker: started };
}

const runsOf = (value: WorkerMessage) => value.type === 'runs';

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

test('a client that starts a run sees the progress of the run in every client', async (t) => {
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
  const running = await watcher.next(
    (value) => value.type === 'runs' && value.runs['/repo']?.issue === 7,
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
  const { socketPath, lockPath, rootsPath } = await worker(t, fake);
  assert.equal(
    await startWorker({
      socketPath,
      lockPath,
      rootsPath,
      version: '2.0.0',
      runRepo: fake.runRepo,
      questions: noQuestions,
    }),
    undefined,
  );
});

test('a worker takes over the lock and the socket file that a dead worker left', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const socketPath = join(dir, 'w.sock');
  const lockPath = join(dir, 'w.lock');
  await writeFile(lockPath, '999999999\n');
  await writeFile(socketPath, '');
  const started = await startWorker({
    socketPath,
    lockPath,
    rootsPath: join(dir, 'w.roots.json'),
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

const QUESTION: Question = {
  issue: 7,
  title: 'Add a flag',
  reason: 'The reviewer gave no verdict.',
  url: 'https://github.com/acme/tool/issues/7#issuecomment-1',
  repo: 'acme/tool',
  labels: { needsHuman: 'status:needs-human', skip: 'status:blocked' },
};

const questionsOf = (value: WorkerMessage) => value.type === 'questions';

test('a client that asks for the waiting questions of a repository gets them', async (t) => {
  const asked: string[] = [];
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async (root) => {
    asked.push(root);
    return [QUESTION];
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo' });
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
  assert.deepEqual(asked, ['/repo']);
});

test('a client that connects gets the waiting questions of every known repository', async (t) => {
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async () => [QUESTION]);
  const asker = await connect(t, socketPath);
  asker.send({ type: 'questions', root: '/repo' });
  await asker.next(questionsOf);
  const later = await connect(t, socketPath);
  assert.deepEqual(await later.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
});

test('a client that connects after a worker restart gets the waiting questions of every known repository', async (t) => {
  const fake = fakeRuns();
  const first = await worker(t, fake, '2.0.0', async () => [QUESTION]);
  const asker = await connect(t, first.socketPath);
  asker.send({ type: 'questions', root: '/repo' });
  await asker.next(questionsOf);
  await first.worker.close();
  const restarted = await startWorker({
    socketPath: first.socketPath,
    lockPath: first.lockPath,
    rootsPath: first.rootsPath,
    version: '2.0.0',
    runRepo: fake.runRepo,
    questions: async () => [QUESTION],
  });
  assert.ok(restarted);
  t.after(() => restarted.close());
  const later = await connect(t, first.socketPath);
  assert.deepEqual(await later.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
});

test('every client gets the new waiting questions after an issue of a run ends', async (t) => {
  const fake = fakeRuns();
  let questions: Question[] = [];
  const { socketPath } = await worker(t, fake, '2.0.0', async () => questions);
  const starter = await connect(t, socketPath);
  const watcher = await connect(t, socketPath);
  starter.send({ type: 'start', root: '/repo', merge: false });
  await watcher.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  questions = [QUESTION];
  fake.controls().onEvent!({ kind: 'issue.end', issue: 7, outcome: 'needs-human' });
  assert.deepEqual(
    await watcher.next((value) => value.type === 'questions' && value.questions.length > 0),
    { type: 'questions', root: '/repo', questions: [QUESTION] },
  );
  questions = [];
  starter.send({ type: 'questions', root: '/repo' });
  assert.deepEqual(
    await starter.next((value) => value.type === 'questions' && value.questions.length === 0),
    {
      type: 'questions',
      root: '/repo',
      questions: [],
    },
  );
  fake.finish();
});

test('a client whose questions cannot be read gets a questions error for the repository', async (t) => {
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async () => {
    throw new Error('gh: not logged in');
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'questions-error'), {
    type: 'questions-error',
    root: '/repo',
    message: 'gh: not logged in',
  });
});

test('a client that asks with an id gets the list read for that ask, tagged with the id, after an older list', async (t) => {
  const pending: ((questions: Question[]) => void)[] = [];
  const { socketPath } = await worker(
    t,
    fakeRuns(),
    '2.0.0',
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo' });
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  while (pending.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  pending[0]!([QUESTION]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
  pending[1]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
    id: 'ask',
  });
});

test('a client whose ask with an id is overtaken by a newer list gets that newer list tagged with the id', async (t) => {
  const pending: ((questions: Question[]) => void)[] = [];
  const { socketPath } = await worker(
    t,
    fakeRuns(),
    '2.0.0',
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  client.send({ type: 'questions', root: '/repo' });
  while (pending.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  pending[1]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
  });
  pending[0]!([QUESTION]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
    id: 'ask',
  });
});

test('a client that asks twice gets no older list after a newer one', async (t) => {
  const pending: ((questions: Question[]) => void)[] = [];
  const { socketPath } = await worker(
    t,
    fakeRuns(),
    '2.0.0',
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo' });
  client.send({ type: 'questions', root: '/repo' });
  while (pending.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  pending[1]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
  });
  pending[0]!([QUESTION]);
  client.send({ type: 'questions', root: '/repo' });
  while (pending.length < 3) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  pending[2]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
  });
});
