import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { recordCommands } from '../src/command-records.mts';
import { run } from '../src/exec.mts';
import type { Recorder } from '../src/observe.mts';
import type { Question, WorkerMessage } from '../src/protocol.mts';
import type { ListQuestions } from '../src/questions.mts';
import type { RunRepo } from '../src/serve.mts';
import { type Harness, harness } from './harness.mts';
import { type Client, connect, fakeRuns, worker } from './worker-harness.mts';

const QUESTION: Question = {
  issue: 7,
  title: 'Add a flag',
  reason: 'The reviewer gave no verdict.',
  url: 'https://github.com/acme/tool/issues/7#issuecomment-1',
  repo: 'acme/tool',
  labels: { needsHuman: 'status:needs-human', skip: 'status:blocked', ready: 'status:todo' },
};

const questionsOf = (value: WorkerMessage) => value.type === 'questions';

async function waitForPending(
  pending: ((questions: Question[]) => void)[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (pending.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${pending.length} of ${count} question reads started`);
    }
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

type EndingRun = { runRepo: RunRepo; endIssue: () => void; finish: () => void };

function endingRun(wrap: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()): EndingRun {
  let endIssue: () => void = () => undefined;
  let finish: () => void = () => undefined;
  return {
    endIssue: () => endIssue(),
    finish: () => finish(),
    runRepo: (_root, _args, controls) =>
      wrap(async () => {
        await new Promise<void>((resolve) => {
          endIssue = resolve;
        });
        controls.onEvent!({ kind: 'issue.end', issue: 7, outcome: 'needs-human' });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return 0;
      }),
  };
}

async function startEndingRun(t: TestContext, ending: EndingRun, questions: ListQuestions) {
  const { socketPath } = await worker(
    t,
    { ...fakeRuns(), runRepo: ending.runRepo },
    '2.0.0',
    questions,
  );
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  return client;
}

const withCommand = async (): Promise<void> => {
  await run(process.execPath, ['-e', '']);
};

test('a client of a run stopped now gets the waiting questions, not an error, when an issue ends', async (t) => {
  const ending = endingRun();
  let questions: Question[] = [];
  const client = await startEndingRun(t, ending, async () => {
    await withCommand();
    return questions;
  });
  await client.next(questionsOf);
  client.send({ type: 'stop', root: '/repo', after: 'now' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'stopping');
  questions = [QUESTION];
  ending.endIssue();
  assert.deepEqual(
    await client.next((value) => value.type === 'questions' || value.type === 'questions-error'),
    { type: 'questions', root: '/repo', questions: [QUESTION] },
  );
  ending.finish();
});

test('a client that asks with an id just before an issue of a run stopped now ends gets the list with its id', async (t) => {
  const ending = endingRun();
  const pending: ((questions: Question[]) => void)[] = [];
  const client = await startEndingRun(t, ending, async () => {
    await withCommand();
    return new Promise((resolve) => pending.push(resolve));
  });
  await answerConnect(pending, client);
  client.send({ type: 'stop', root: '/repo', after: 'now' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo']?.status === 'stopping');
  client.send({ type: 'questions', root: '/repo', id: 'ask' });
  await waitForPending(pending, 1);
  ending.endIssue();
  await waitForPending(pending, 2);
  pending[1]!([QUESTION]);
  pending[0]!([]);
  assert.deepEqual(
    await client.next(
      (value) =>
        (value.type === 'questions' || value.type === 'questions-error') && value.id === 'ask',
    ),
    { type: 'questions', root: '/repo', questions: [QUESTION], id: 'ask' },
  );
  ending.finish();
});

test('a run whose issue ends writes no command events of the question read to its log', async (t) => {
  const events: string[] = [];
  const recorder = { event: (kind: string) => events.push(kind) } as unknown as Recorder;
  const ending = endingRun((work) => recordCommands(recorder, work));
  let read = 0;
  const client = await startEndingRun(t, ending, async () => {
    read += 1;
    await withCommand();
    return read > 1 ? [QUESTION] : [];
  });
  await client.next(questionsOf);
  ending.endIssue();
  await client.next((value) => value.type === 'questions' && value.questions.length > 0);
  assert.deepEqual(events, []);
  ending.finish();
});

test('every client of a run whose issue ends in error gets the waiting questions read after the hand-over sets the needs-human label', async (t) => {
  const reads: boolean[] = [];
  let target: Harness | undefined;
  const runRepo: RunRepo = async (_root, _args, controls) => {
    target = await harness(t, { fail: 'runAgent', onEvent: controls.onEvent });
    const setLabel = target.context.ports.setLabel;
    target.context.ports.setLabel = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return setLabel(...args);
    };
    await target.run();
    return 0;
  };
  const { socketPath } = await worker(t, { ...fakeRuns(), runRepo }, '2.0.0', async () => {
    const labelled = target?.labels.some((entry) => entry.label === 'status:needs-human') ?? false;
    reads.push(labelled);
    return labelled ? [QUESTION] : [];
  });
  const client = await connect(t, socketPath);
  await client.next(questionsOf);
  client.send({ type: 'start', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'questions'), {
    type: 'questions',
    root: '/repo',
    questions: [QUESTION],
  });
  assert.deepEqual(reads, [false, true]);
});
