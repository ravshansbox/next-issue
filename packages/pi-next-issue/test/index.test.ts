import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createExtension, formatStatus } from '../index.ts';
import { type Progress, WorkerClient } from '../src/worker.ts';
import { type FakeWorker, running, socketPath, startFakeWorker, until } from './fake-worker.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

function host(mode = 'tui', cwd = '/repo') {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, options.handler),
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  const painted: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const status: Array<string | undefined> = [];
  const notes: string[] = [];
  const plain = (text: string) => /^<dim>(.*)<\/dim>$/s.exec(text)?.[1] ?? text;
  const ctx = {
    hasUI: true,
    mode,
    cwd,
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      setStatus: (_key: string, text: string | undefined) => {
        painted.push(text);
        status.push(text === undefined ? undefined : plain(text));
      },
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      notify: (text: string) => notes.push(text),
    },
  };
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  };
  const command = () => commands.get('next-issue')!('', ctx);
  return { pi, ctx, status, painted, widgets, notes, emit, command };
}

const KEY = Symbol.for('pi-next-issue');
const workers: FakeWorker[] = [];

afterEach(async () => {
  const store = globalThis as Record<symbol, WorkerClient | undefined>;
  store[KEY]?.close();
  delete store[KEY];
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

function setup(options: { version?: string; spawn?: (path: string) => Promise<void> } = {}) {
  const path = socketPath();
  const spawns: string[] = [];
  const extension = createExtension({
    client: () =>
      new WorkerClient({
        socketPath: path,
        version: options.version ?? '1.0.0',
        spawnWorker: (version) => {
          spawns.push(version);
          void options.spawn?.(path);
        },
        startTimeoutMs: 2000,
        reconnectMs: 50,
      }),
    root: async (cwd) => {
      if (cwd === '/outside') {
        throw new Error('not a git repository');
      }
      return cwd;
    },
  });
  return { path, spawns, extension };
}

async function worker(path: string, version = '1.0.0') {
  const started = await startFakeWorker(path, version);
  workers.push(started);
  return started;
}

test('a user who runs /next-issue with no worker going starts one and asks it to run this repository with merge on', async () => {
  let started: FakeWorker | undefined;
  const { spawns, extension } = setup({
    spawn: async (path) => {
      started = await worker(path);
    },
  });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  assert.equal(spawns.length, 1);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
  assert.deepEqual(
    started!.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo', merge: true },
  );
});

test('a user who runs /next-issue with no worker going starts the worker release that matches the extension version', async () => {
  const { spawns, extension } = setup({ version: '1.2.3' });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command().catch(() => {});
  assert.deepEqual(spawns, ['1.2.3']);
});

test('a user who opens pi with no worker going does not start one', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, status } = host();
  extension(pi as never);
  await emit('session_start');
  assert.equal(spawns.length, 0);
  assert.deepEqual(status, []);
});

test('a user sees the run of this repository in the footer in the dim colour of the theme and no line above the editor', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, painted, widgets } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/other', running({ issue: 1 }));
  fake.update(
    '/repo',
    running({
      issue: 7,
      stage: 'implement',
      tools: 1,
      lastTool: 'bash npm test',
      issueStartedAt: Date.now(),
    }),
  );
  await until(() => painted.at(-1)?.includes('#7') === true);
  assert.match(painted.at(-1) ?? '', /^<dim>next-issue #7 · implement · 1 tools · \d+s<\/dim>$/);
  assert.deepEqual(widgets, []);
});

test('a user of an rpc client sees the footer status without colour codes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, painted } = host('rpc');
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issue: 7, stage: 'review 1', tools: 3, lastTool: 'read a.ts' }));
  await until(() => painted.at(-1) === 'next-issue #7 · review 1 · 3 tools');
});

test('a user sees a note per handled issue and a note when the run finishes, with the summary in the footer', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issue: 7 }));
  await until(() => status.length > 0);
  fake.update('/repo', running({ handled: [{ issue: 7, outcome: 'done' }] }));
  fake.update('/repo', {
    status: 'finished',
    tools: 0,
    handled: [
      { issue: 7, outcome: 'done' },
      { issue: 8, outcome: 'needs-human' },
    ],
  });
  await until(() => notes.includes('next-issue finished'));
  assert.deepEqual(notes, [
    'next-issue: #7 done',
    'next-issue: #8 needs a human',
    'next-issue finished',
  ]);
  assert.equal(status.at(-1), 'next-issue · finished: 1 done, 1 needs a human');
});

test('a user who opens pi after a run has finished sees its summary in the footer and no notes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'finished',
    tools: 0,
    handled: [{ issue: 8, outcome: 'needs-human' }],
  };
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.length > 0);
  assert.equal(status.at(-1), 'next-issue · finished: 0 done, 1 needs a human');
  assert.deepEqual(notes, []);
});

test('a user who runs /next-issue while a run is going asks the worker to stop it', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issue: 7 });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await until(() => fake.received.some((message) => message.type === 'stop'));
  assert.deepEqual(fake.received.at(-1), { type: 'stop', root: '/repo' });
});

test('a user who runs /next-issue after a run has stopped starts a new run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = { status: 'stopped', tools: 0, handled: [] };
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await until(() => fake.received.some((message) => message.type === 'start'));
});

test('a user who quits pi leaves the run going', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await until(() => fake.received.some((message) => message.type === 'start'));
  await emit('session_shutdown', { reason: 'quit' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'stop'),
    false,
  );
});

test('a user in a second pi sees the run that the first pi started', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issue: 9, stage: 'checks' });
  const { pi, emit, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === 'next-issue #9 · checks · 0 tools');
});

test('a user sees why the worker could not start a run in this repository', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  fake.reply({ type: 'error', root: '/other', message: 'not this one' });
  fake.reply({
    type: 'error',
    root: '/repo',
    message: 'a run is going in this repository already',
  });
  await until(() => notes.length > 0);
  assert.deepEqual(notes, ['next-issue cannot start: a run is going in this repository already']);
});

test('a user outside a git repository sees why a run could not start', async () => {
  const { extension } = setup();
  const { pi, command, notes } = host('tui', '/outside');
  extension(pi as never);
  await command();
  assert.deepEqual(notes, ['next-issue cannot start: not a git repository']);
});

test('a user sees why a run could not start when the worker does not come up', async () => {
  const { extension } = setup();
  const { pi, command, notes } = host();
  extension(pi as never);
  await command();
  assert.match(notes[0] ?? '', /^next-issue cannot start: the next-issue worker did not start/);
});

test('a user with a newer extension gets a new worker once the old idle worker closes', async () => {
  let fresh: FakeWorker | undefined;
  const { path, spawns, extension } = setup({
    version: '2.0.0',
    spawn: async (socket) => {
      fresh = await worker(socket, '2.0.0');
    },
  });
  const old = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'hello') {
      void self.close();
    }
  });
  workers.push(old);
  const { pi, command } = host();
  extension(pi as never);
  await command();
  assert.equal(spawns.length, 1);
  await until(() => fresh?.received.some((message) => message.type === 'start') === true);
  assert.equal(
    old.received.some((message) => message.type === 'start'),
    false,
  );
});

const now = 1_000_000;

function progress(fields: Partial<Progress>): Progress {
  return { status: 'running', tools: 0, handled: [], ...fields };
}

test('a user sees the issue, the stage, the tool count and the time spent in the footer', () => {
  assert.equal(
    formatStatus(
      progress({ issue: 12, stage: 'review 1', tools: 37, issueStartedAt: now - 252_000 }),
      now,
    ),
    'next-issue #12 · review 1 · 37 tools · 4m12s',
  );
  assert.equal(formatStatus(progress({}), now), 'next-issue · looking for issues');
});

test('a user sees a finished or stopped run summed up by outcome in the footer', () => {
  const handled = [
    { issue: 1, outcome: 'done' as const },
    { issue: 2, outcome: 'needs-human' as const },
    { issue: 3, outcome: 'error' as const },
  ];
  assert.equal(
    formatStatus(progress({ status: 'finished', handled }), now),
    'next-issue · finished: 1 done, 1 needs a human, 1 failed',
  );
  assert.equal(formatStatus(progress({ status: 'stopped' }), now), 'next-issue · stopped: 0 done');
  assert.equal(
    formatStatus(progress({ status: 'stopping', issue: 4 }), now),
    'next-issue #4 · stopping',
  );
});

test('a user sees the error of a failed run in the footer', () => {
  assert.equal(
    formatStatus(progress({ status: 'failed', error: 'gh failed' }), now),
    'next-issue · failed: gh failed',
  );
});
