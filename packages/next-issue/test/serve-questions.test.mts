import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Question, WorkerMessage } from '../src/protocol.mts';
import { type Client, connect, fakeRuns, worker } from './worker-harness.mts';

const QUESTION: Question = {
  issue: 7,
  title: 'Add a flag',
  reason: 'The reviewer gave no verdict.',
  url: 'https://github.com/acme/tool/issues/7#issuecomment-1',
  repo: 'acme/tool',
  labels: { needsHuman: 'status:needs-human', skip: 'status:blocked' },
};

const questionsOf = (value: WorkerMessage) => value.type === 'questions';

async function waitForPending(
  pending: ((questions: Question[]) => void)[],
  count: number,
): Promise<void> {
  while (pending.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function answerConnect(
  pending: ((questions: Question[]) => void)[],
  client: Client,
): Promise<void> {
  await waitForPending(pending, 1);
  pending.shift()!([]);
  await client.next(questionsOf);
}

test('a client that asks for the waiting questions of a repository gets them', async (t) => {
  const asked: string[] = [];
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async (root) => {
    asked.push(root);
    return [QUESTION];
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  assert.deepEqual(await client.next((value) => value.type === 'questions' && value.id === 'ask'), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
    id: 'ask',
  });
  assert.deepEqual([...new Set(asked)], ['/repo']);
});

test('a client that connects gets the waiting questions of the repository of the worker', async (t) => {
  const asked: string[] = [];
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', async (root) => {
    asked.push(root);
    return [QUESTION];
  });
  const client = await connect(t, socketPath);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
  assert.deepEqual(asked, ['/repo']);
});

test('every client gets the new waiting questions after an issue of a run ends', async (t) => {
  const fake = fakeRuns();
  let questions: Question[] = [];
  const { socketPath } = await worker(t, fake, '2.0.0', async () => questions);
  const starter = await connect(t, socketPath);
  const watcher = await connect(t, socketPath);
  starter.send({ type: 'start', root: '/repo' });
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
  await answerConnect(pending, client);
  client.send({ type: 'questions', root: '/repo' });
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  await waitForPending(pending, 2);
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
  await answerConnect(pending, client);
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  client.send({ type: 'questions', root: '/repo' });
  await waitForPending(pending, 2);
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
  await answerConnect(pending, client);
  client.send({ type: 'questions', root: '/repo' });
  client.send({ type: 'questions', root: '/repo' });
  await waitForPending(pending, 2);
  pending[1]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
  });
  pending[0]!([QUESTION]);
  client.send({ type: 'questions', root: '/repo' });
  await waitForPending(pending, 3);
  pending[2]!([]);
  assert.deepEqual(await client.next(questionsOf), {
    type: 'questions',
    root: '/repo',
    questions: [],
  });
});
