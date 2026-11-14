import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createExtension } from '../index.ts';
import type { Progress, Question } from '../src/protocol.ts';
import { formatStatus } from '../src/status.ts';
import { WorkerClient } from '../src/worker.ts';
import {
  type FakeWorker,
  running,
  socketPath,
  startFakeWorker,
  until,
  working,
} from './fake-worker.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: { started?: boolean; root: string };
};
type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResult>;

function host(mode = 'tui', cwd = '/repo', answers: Array<string | undefined> = []) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolExecute>();
  const completions = new Map<string, (prefix: string) => unknown>();
  const pi = {
    registerTool: (options: { name: string; execute: ToolExecute }) =>
      tools.set(options.name, options.execute),
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => unknown;
      },
    ) => {
      commands.set(name, options.handler);
      if (options.getArgumentCompletions !== undefined) {
        completions.set(name, options.getArgumentCompletions);
      }
    },
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  const painted: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const status: Array<string | undefined> = [];
  const waiting: Array<string | undefined> = [];
  const asked: string[] = [];
  const notes: string[] = [];
  const plain = (text: string) => /^<dim>(.*)<\/dim>$/s.exec(text)?.[1] ?? text;
  const ctx = {
    hasUI: true,
    mode,
    cwd,
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      setStatus: (key: string, text: string | undefined) => {
        if (key === 'next-issue-questions') {
          waiting.push(text);
          return;
        }
        painted.push(text);
        status.push(text === undefined ? undefined : plain(text));
      },
      select: async (title: string) => {
        asked.push(title);
        return answers.shift();
      },
      editor: async () => answers.shift(),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      notify: (text: string) => notes.push(text),
    },
  };
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  };
  const command = (args = '') => commands.get('next-issue')!(args, ctx);
  const complete = (prefix: string) => completions.get('next-issue')?.(prefix);
  const start = (signal?: AbortSignal, params: unknown = {}) =>
    tools.get('next_issue_start')!('call', params, signal, undefined, ctx);
  const report = () => tools.get('next_issue_status')!('call', {}, undefined, undefined, ctx);
  return {
    pi,
    ctx,
    status,
    waiting,
    asked,
    painted,
    widgets,
    notes,
    emit,
    command,
    complete,
    start,
    report,
  };
}

const KEY = Symbol.for('pi-next-issue');
const workers: FakeWorker[] = [];

afterEach(async () => {
  const store = globalThis as Record<symbol, Map<string, WorkerClient> | undefined>;
  for (const client of store[KEY]?.values() ?? []) {
    client.close();
  }
  delete store[KEY];
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

type GhCall = { args: string[]; cwd: string; input?: string };

function setup(
  options: {
    version?: string;
    spawn?: (path: string) => Promise<void>;
    gh?: (call: GhCall) => string | undefined;
    paths?: Record<string, string>;
  } = {},
) {
  const path = socketPath();
  const spawns: string[] = [];
  const calls: GhCall[] = [];
  const extension = createExtension({
    client: (root) =>
      new WorkerClient({
        socketPath: options.paths?.[root] ?? path,
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
    gh: async (args, run) => {
      const call: GhCall = {
        args,
        cwd: run.cwd,
        ...(run.input === undefined ? {} : { input: run.input }),
      };
      calls.push(call);
      return options.gh?.(call) ?? '';
    },
  });
  return { path, spawns, calls, extension };
}

async function worker(path: string, version = '1.0.0') {
  const started = await startFakeWorker(path, version);
  workers.push(started);
  return started;
}

test('a user who runs /next-issue start with no worker going starts one and asks it to run this repository', async () => {
  let started: FakeWorker | undefined;
  const { spawns, extension } = setup({
    spawn: async (path) => {
      started = await worker(path);
    },
  });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
  assert.equal(spawns.length, 1);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
  assert.deepEqual(
    started!.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo' },
  );
});

test('a model that calls next_issue_start with no worker going starts one, asks it to run this repository and reports the start', async () => {
  let started: FakeWorker | undefined;
  const { spawns, extension } = setup({
    spawn: async (path) => {
      started = await startFakeWorker(path, '1.0.0', (self, message) => {
        if (message.type === 'start') {
          self.update(message.root, running());
        }
      });
      workers.push(started);
    },
  });
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await start();
  assert.equal(spawns.length, 1);
  assert.deepEqual(result.details, { started: true, root: '/repo' });
  assert.equal(result.content[0]?.text, 'Started a next-issue run of /repo.');
  await until(() => started?.received.some((message) => message.type === 'start') === true);
  assert.deepEqual(
    started!.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo' },
  );
});

test('a model that calls next_issue_start with args asks the worker for a run with those flags', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'start') {
      self.update(message.root, running());
    }
  });
  workers.push(fake);
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await start(undefined, { args: ['--hunt'] });
  assert.deepEqual(result.details, { started: true, root: '/repo' });
  assert.deepEqual(
    fake.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo', args: ['--hunt'] },
  );
});

test('a model that calls next_issue_start while a run is going starts nothing and reports the current run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7, { stage: 'implement', tools: 3 })] });
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await start();
  assert.deepEqual(result.details, { started: false, root: '/repo' });
  assert.equal(
    result.content[0]?.text,
    'A run of /repo is going already, so nothing started: #7 · implement · 3 tools. It picks up new issues by itself.',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'start' || message.type === 'stop'),
    [],
  );
});

test('a model that calls next_issue_start gets the error when the worker refuses to start a run', async () => {
  const { path, extension } = setup();
  const refusing = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'start') {
      self.reply({ type: 'error', root: '/other', message: 'not this one' });
      self.reply({
        type: 'error',
        root: message.root,
        message: 'the worker is restarting, try again soon',
      });
    }
  });
  workers.push(refusing);
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(start(), /the worker is restarting, try again soon/);
});

test('a model that calls next_issue_start gets an error when the worker closes the connection before the run starts', async () => {
  const { path, extension } = setup();
  const closing = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'start') {
      void self.close();
    }
  });
  workers.push(closing);
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(start(), /the worker closed the connection/);
});

test('a model that cancels next_issue_start while the worker does not answer gets an error', async () => {
  const { path, extension } = setup();
  workers.push(await worker(path));
  const { pi, emit, start } = host();
  extension(pi as never);
  await emit('session_start');
  const controller = new AbortController();
  const result = start(controller.signal);
  controller.abort();
  await assert.rejects(result, /cancelled/);
});

test('a model that calls next_issue_start outside a git repository gets the error', async () => {
  const { extension } = setup();
  const { pi, start } = host('tui', '/outside');
  extension(pi as never);
  await assert.rejects(start(), /not a git repository/);
});

test('a model that calls next_issue_status sees the run of this repository and each handled issue with its outcome', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/other'] = running({ issues: [working(3, { stage: 'review 1', tools: 9 })] });
  fake.runs['/repo'] = running({
    issues: [working(191, { stage: 'implement', tools: 12 })],
    handled: [
      { issue: 190, outcome: 'done' },
      { issue: 189, outcome: 'needs-human' },
      { issue: 188, outcome: 'error' },
    ],
  });
  const { pi, report } = host();
  extension(pi as never);
  const result = await report();
  assert.equal(
    result.content[0]?.text,
    '#191 · implement · 12 tools\n#190 done\n#189 needs a human\n#188 failed',
  );
});

test('a model that calls next_issue_status while the worker has no run of this repository is told so', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/other'] = running({ issues: [working(3)] });
  const { pi, emit, report } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await report();
  assert.equal(result.content[0]?.text, 'no run of /repo');
});

test('a model that calls next_issue_status with no worker going is told so and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, report } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await report();
  assert.equal(result.content[0]?.text, 'no worker is running');
  assert.equal(spawns.length, 0);
});

test('a user who runs /next-issue start with no worker going starts the worker release that matches the extension version', async () => {
  const { spawns, extension } = setup({ version: '1.2.3' });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start').catch(() => {});
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
  fake.update('/other', running({ issues: [working(1)] }));
  fake.update(
    '/repo',
    running({
      issues: [
        working(7, {
          stage: 'implement',
          tools: 1,
          lastTool: 'bash npm test',
          startedAt: Date.now(),
        }),
      ],
    }),
  );
  await until(() => painted.at(-1)?.includes('#7') === true);
  assert.match(painted.at(-1) ?? '', /^<dim>#7 · implement · 1 tools · \d+s<\/dim>$/);
  assert.deepEqual(widgets, []);
});

test('a user of an rpc client sees the footer status without colour codes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, painted } = host('rpc');
  extension(pi as never);
  await emit('session_start');
  fake.update(
    '/repo',
    running({ issues: [working(7, { stage: 'review 1', tools: 3, lastTool: 'read a.ts' })] }),
  );
  await until(() => painted.at(-1) === '#7 · review 1 · 3 tools');
});

test('a user sees a note per handled issue and a note when the run finishes, with the summary in the footer', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issues: [working(7)] }));
  await until(() => status.length > 0);
  fake.update('/repo', running({ handled: [{ issue: 7, outcome: 'done' }] }));
  fake.update('/repo', {
    status: 'finished',
    issues: [],
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
  assert.equal(status.at(-1), 'finished: 1 done, 1 needs a human');
});

test('a user who opens pi after a run has finished sees its summary in the footer and no notes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'finished',
    issues: [],
    handled: [{ issue: 8, outcome: 'needs-human' }],
  };
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.length > 0);
  assert.equal(status.at(-1), 'finished: 0 done, 1 needs a human');
  assert.deepEqual(notes, []);
});

test('a user who runs /next-issue stop while a run is going asks the worker to stop it', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop');
  await until(() => fake.received.some((message) => message.type === 'stop'));
  assert.deepEqual(fake.received.at(-1), { type: 'stop', root: '/repo', after: 'issue' });
});

test('a user who runs /next-issue stop --after round or now asks the worker to stop at that point', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop --after round');
  await command('stop  --after now ');
  await until(() => fake.received.filter((message) => message.type === 'stop').length === 2);
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'stop'),
    [
      { type: 'stop', root: '/repo', after: 'round' },
      { type: 'stop', root: '/repo', after: 'now' },
    ],
  );
});

test('a user who runs /next-issue stop with an unknown point or flag sees an error and nothing stops', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop --after tool');
  await command('stop --after');
  await command('stop --now');
  assert.deepEqual(notes, [
    'next-issue cannot stop: --after takes issue, round or now, not tool',
    'next-issue cannot stop: --after takes issue, round or now',
    'next-issue cannot stop: stop does not take --now',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'stop'),
    false,
  );
});

test('a user who runs /next-issue stop with no run going is told so and nothing is sent', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop');
  assert.deepEqual(notes, ['No run of /repo is going.']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'stop' || message.type === 'start'),
    false,
  );
});

test('a user who runs /next-issue start --hunt asks the worker for a run with those flags', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start  --hunt --max 3 ');
  await until(() => fake.received.some((message) => message.type === 'start'));
  assert.deepEqual(
    fake.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo', args: ['--hunt', '--max', '3'] },
  );
});

test('a user who runs /next-issue start while a run is going is told so and nothing starts or stops', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7, { stage: 'implement', tools: 3 })] });
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start --hunt');
  assert.deepEqual(notes, [
    'A run of /repo is going already, so nothing started: #7 · implement · 3 tools. It picks up new issues by itself.',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'start' || message.type === 'stop'),
    [],
  );
});

test('a user who runs /next-issue with no argument or an unknown one sees the usage and nothing starts or stops', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await command('go');
  assert.equal(notes.length, 2);
  for (const note of notes) {
    assert.match(note, /\/next-issue start \[flags\]/);
    assert.match(note, /\/next-issue stop \[--after issue\|round\|now\]/);
    assert.match(note, /\/next-issue answer/);
    assert.match(note, /--hunt/);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'start' || message.type === 'stop'),
    [],
  );
});

test('a user who runs /next-issue start after a run has stopped starts a new run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = { status: 'stopped', issues: [], handled: [] };
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
  await until(() => fake.received.some((message) => message.type === 'start'));
});

test('a user who quits pi leaves the run going', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
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
  fake.runs['/repo'] = running({ issues: [working(9, { stage: 'checks' })] });
  const { pi, emit, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === '#9 · checks · 0 tools');
});

test('a user sees why the worker could not start a run in this repository', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
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
  await command('start');
  assert.deepEqual(notes, ['next-issue cannot start: not a git repository']);
});

test('a user outside a git repository who runs /next-issue stop sees why the run could not stop', async () => {
  const { extension } = setup();
  const { pi, command, notes } = host('tui', '/outside');
  extension(pi as never);
  await command('stop');
  assert.deepEqual(notes, ['next-issue cannot stop: not a git repository']);
});

test('a user sees why a run could not start when the worker does not come up', async () => {
  const { extension } = setup();
  const { pi, command, notes } = host();
  extension(pi as never);
  await command('start');
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
  await command('start');
  assert.equal(spawns.length, 1);
  await until(() => fresh?.received.some((message) => message.type === 'start') === true);
  assert.equal(
    old.received.some((message) => message.type === 'start'),
    false,
  );
});

test('a user starts a run in one repository while a run is going in another, each with its own worker', async () => {
  const paths = { '/one': socketPath(), '/two': socketPath() };
  const one = await worker(paths['/one']);
  const two = await worker(paths['/two']);
  one.runs['/one'] = running();
  const { extension } = setup({ paths });
  const first = host('tui', '/one');
  const second = host('tui', '/two');
  extension(first.pi as never);
  extension(second.pi as never);
  await first.emit('session_start');
  await second.emit('session_start');
  await second.command('start');
  await until(() => two.received.some((message) => message.type === 'start'));
  assert.deepEqual(
    two.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/two' },
  );
  assert.equal(
    one.received.some((message) => message.type === 'start'),
    false,
  );
});

test('a user whose worker socket path is too long for the system sees an error that says so', async () => {
  const long = `/${'a'.repeat(200)}/worker.sock`;
  const { spawns, extension } = setup({ paths: { '/long': long } });
  const { pi, command, notes } = host('tui', '/long');
  extension(pi as never);
  await command('start');
  assert.equal(spawns.length, 0);
  assert.match(
    notes[0] ?? '',
    /^next-issue cannot start: the socket path \/a+\/worker\.sock is too long for this system/,
  );
});

const now = 1_000_000;

function progress(fields: Partial<Progress>): Progress {
  return { status: 'running', issues: [], handled: [], ...fields };
}

test('a user sees each running issue with its stage, tool count and time spent in the footer', () => {
  assert.equal(
    formatStatus(
      progress({
        issues: [working(12, { stage: 'review 1', tools: 37, startedAt: now - 252_000 })],
      }),
      now,
    ),
    '#12 · review 1 · 37 tools · 4m12s',
  );
  assert.equal(
    formatStatus(
      progress({
        issues: [
          working(12, { stage: 'review 1', tools: 37, startedAt: now - 252_000 }),
          working(13, { tools: 2, startedAt: now - 40_000 }),
        ],
      }),
      now,
    ),
    '#12 · review 1 · 37 tools · 4m12s | #13 · prepare · 2 tools · 40s',
  );
  assert.equal(formatStatus(progress({}), now), 'looking for issues');
});

test('a user sees each running issue with the open-issue count of the latest fetch in the footer', () => {
  assert.equal(
    formatStatus(
      progress({
        open: 7,
        issues: [
          working(12, { stage: 'implement', tools: 3, startedAt: now - 41_000 }),
          working(13, { stage: 'review fix 2/5', tools: 1 }),
        ],
      }),
      now,
    ),
    '#12/7 · implement · 3 tools · 41s | #13/7 · review fix 2/5 · 1 tools',
  );
  assert.equal(
    formatStatus(
      progress({ open: 1, issues: [working(225, { stage: 'implement', tools: 0 })] }),
      now,
    ),
    '#225/1 · implement · 0 tools',
  );
});

test('a user sees a finished or stopped run summed up by outcome in the footer', () => {
  const handled = [
    { issue: 1, outcome: 'done' as const },
    { issue: 2, outcome: 'needs-human' as const },
    { issue: 3, outcome: 'error' as const },
  ];
  assert.equal(
    formatStatus(progress({ status: 'finished', handled }), now),
    'finished: 1 done, 1 needs a human, 1 failed',
  );
  assert.equal(formatStatus(progress({ status: 'stopped' }), now), 'stopped: 0 done');
  assert.equal(
    formatStatus(progress({ status: 'stopping', issues: [working(4)] }), now),
    '#4 · stopping',
  );
});

test('a user whose older worker sends progress without running issues sees the footer without an error', () => {
  const { issues: _issues, ...older } = progress({});
  assert.equal(formatStatus(older as Progress, now), 'looking for issues');
  assert.equal(formatStatus({ ...older, status: 'stopping' } as Progress, now), '#? · stopping');
});

test('a user sees the error of a failed run in the footer', () => {
  assert.equal(
    formatStatus(progress({ status: 'failed', error: 'gh failed' }), now),
    'failed: gh failed',
  );
});

function question(issue: number): Question {
  return {
    issue,
    title: `Title ${issue}`,
    reason: `Reason ${issue}`,
    url: '',
    repo: 'owner/name',
    labels: { needsHuman: 'status:needs-human', skip: 'status:blocked' },
  };
}

async function questionWorker(path: string, lists: Question[][], stale?: Question[]) {
  let list: Question[] = lists[0] ?? [];
  const started = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'questions') {
      if (stale !== undefined && message.id !== undefined) {
        self.reply({ type: 'questions', root: message.root, questions: stale });
      }
      if (message.id !== undefined) {
        list = lists.length > 1 ? lists.shift()! : list;
      }
      self.reply({
        type: 'questions',
        root: message.root,
        questions: list,
        ...(message.id === undefined ? {} : { id: message.id }),
      });
    }
  });
  workers.push(started);
  return started;
}

test('a user who types /next-issue followed by nothing or a start of a subcommand is offered the matching subcommands', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const item = (value: string) => ({ value, label: value });
  assert.deepEqual(complete(''), [item('start'), item('stop'), item('answer')]);
  assert.deepEqual(complete('st'), [item('start'), item('stop')]);
  assert.deepEqual(complete('an'), [item('answer')]);
  assert.equal(complete('x'), null);
});

const flagItems = {
  once: { label: '--once', description: 'Stop after the first handled issue' },
  max: { label: '--max', description: 'Handle at most n issues' },
  watch: {
    label: '--watch',
    description: 'Keep running, and read the open issues again after each pass',
  },
  hunt: { label: '--hunt', description: 'Hunt the repository for bugs alongside the issues' },
  reset: {
    label: '--reset',
    description: 'Drop the saved budgets and findings, and keep the rest of the state',
  },
  verbose: { label: '--verbose', description: 'Show every command and all agent output' },
  quiet: { label: '--quiet', description: 'Show only the milestones and the summary' },
};

test('a user who types /next-issue start followed by a space is offered all seven flags', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  assert.deepEqual(complete('start '), [
    { value: 'start --once', ...flagItems.once },
    { value: 'start --max ', ...flagItems.max },
    { value: 'start --watch', ...flagItems.watch },
    { value: 'start --hunt', ...flagItems.hunt },
    { value: 'start --reset', ...flagItems.reset },
    { value: 'start --verbose', ...flagItems.verbose },
    { value: 'start --quiet', ...flagItems.quiet },
  ]);
});

test('a user who types the start of a flag after /next-issue start is offered only the matching flags', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  assert.deepEqual(complete('start --h'), [{ value: 'start --hunt', ...flagItems.hunt }]);
  assert.deepEqual(complete('start --hunt --q'), [
    { value: 'start --hunt --quiet', ...flagItems.quiet },
  ]);
  assert.deepEqual(complete('start --m'), [{ value: 'start --max ', ...flagItems.max }]);
  assert.equal(complete('start --x'), null);
});

test('a user who already typed a flag after /next-issue start is not offered it again', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const values = (complete('start --hunt --max 3 ') as Array<{ value: string }>).map(
    (item) => item.value,
  );
  assert.deepEqual(values, [
    'start --hunt --max 3 --once',
    'start --hunt --max 3 --watch',
    'start --hunt --max 3 --reset',
    'start --hunt --max 3 --verbose',
    'start --hunt --max 3 --quiet',
  ]);
});

test('a user who types /next-issue stop or answer followed by a space is offered no flags', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  assert.equal(complete('stop '), null);
  assert.equal(complete('answer '), null);
  assert.equal(complete('stop --'), null);
});

test('a user sees how many questions wait in the footer and a note for each new question', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, waiting, notes } = host();
  extension(pi as never);
  await emit('session_start');
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4)] });
  await until(() => waiting.at(-1) === '<dim>1 question waiting</dim>');
  fake.reply({ type: 'questions', root: '/other', questions: [question(9)] });
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4), question(5)] });
  await until(() => waiting.at(-1) === '<dim>2 questions waiting</dim>');
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4), question(5)] });
  await until(() => waiting.length === 3);
  assert.deepEqual(notes, ['next-issue: #5 has a question: Title 5']);
});

test('a user sees the count drop when a question is answered elsewhere, with no action in this pi', async () => {
  const { path, calls, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, waiting, notes } = host();
  extension(pi as never);
  await emit('session_start');
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4), question(5)] });
  await until(() => waiting.at(-1) === '<dim>2 questions waiting</dim>');
  fake.reply({ type: 'questions', root: '/repo', questions: [question(5)] });
  await until(() => waiting.at(-1) === '<dim>1 question waiting</dim>');
  fake.reply({ type: 'questions', root: '/repo', questions: [] });
  await until(() => waiting.at(-1) === undefined);
  assert.deepEqual(notes, []);
  assert.deepEqual(calls, []);
});

test('a user of an rpc client sees the question count in the footer without colour codes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, waiting } = host('rpc');
  extension(pi as never);
  await emit('session_start');
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4)] });
  await until(() => waiting.at(-1) === '1 question waiting');
});

test('a user with pi open has the worker asked for the waiting questions every minute', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit } = host();
  extension(pi as never);
  await emit('session_start');
  const asks = () => fake.received.filter((message) => message.type === 'questions').length;
  await until(() => asks() === 1);
  t.mock.timers.tick(59_999);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asks(), 1);
  t.mock.timers.tick(1);
  await until(() => asks() === 2);
});

test('a user who opens pi asks the worker for the waiting questions of this repository', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => fake.received.some((message) => message.type === 'questions'));
  assert.deepEqual(
    fake.received.find((message) => message.type === 'questions'),
    { type: 'questions', root: '/repo' },
  );
});

test('a user who answers retry takes the needs-human label off the issue', async () => {
  const { path, calls, extension } = setup();
  await questionWorker(path, [[question(4)], []]);
  const { pi, emit, command, asked, notes } = host('tui', '/repo', ['Retry']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(asked, ['#4 Title 4\n\nReason 4']);
  assert.deepEqual(calls, [
    {
      args: ['issue', 'edit', '4', '--repo', 'owner/name', '--remove-label', 'status:needs-human'],
      cwd: '/repo',
    },
  ]);
  assert.ok(notes.includes('next-issue: #4 will be retried'));
});

test('a user who answers retry with guidance posts it on the issue, then takes the label off', async () => {
  const { path, calls, extension } = setup();
  await questionWorker(path, [[question(4)], []]);
  const { pi, emit, command } = host('tui', '/repo', ['Retry with guidance', 'Use the cache']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(calls, [
    {
      args: ['issue', 'comment', '4', '--repo', 'owner/name', '--body-file', '-'],
      cwd: '/repo',
      input: 'Use the cache',
    },
    {
      args: ['issue', 'edit', '4', '--repo', 'owner/name', '--remove-label', 'status:needs-human'],
      cwd: '/repo',
    },
  ]);
});

function labelledGh(repoLabels: string[], createFails = false) {
  const issueLabels = new Set(['status:needs-human']);
  const gh = ({ args }: GhCall): string | undefined => {
    const [noun, verb] = args;
    if (noun === 'label' && verb === 'list') {
      return JSON.stringify(repoLabels.map((name) => ({ name })));
    }
    if (noun === 'label' && verb === 'create') {
      if (createFails) {
        throw new Error('gh label create failed: HTTP 403');
      }
      repoLabels.push(args[2] ?? '');
      return undefined;
    }
    if (noun === 'issue' && verb === 'edit') {
      const added = args.filter((_, index) => args[index - 1] === '--add-label');
      const removed = args.filter((_, index) => args[index - 1] === '--remove-label');
      const unknown = added.find((label) => !repoLabels.includes(label));
      if (unknown !== undefined) {
        throw new Error(`'${unknown}' not found`);
      }
      removed.forEach((label) => issueLabels.delete(label));
      added.forEach((label) => issueLabels.add(label));
    }
    return undefined;
  };
  return { gh, issueLabels, repoLabels };
}

test('a user who gives up in a repository without the skip label creates it and sees it on the issue', async () => {
  const fake = labelledGh([]);
  const { path, calls, extension } = setup({ gh: fake.gh });
  await questionWorker(path, [[question(4)], []]);
  const { pi, emit, command, notes } = host('tui', '/repo', ['Give up']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual([...fake.issueLabels], ['status:blocked']);
  assert.deepEqual(fake.repoLabels, ['status:blocked']);
  assert.equal(calls.filter((call) => call.args[1] === 'create').length, 1);
  assert.ok(notes.includes('next-issue: #4 given up'));
});

test('a user who gives up in a repository with the skip label does not create it again', async () => {
  const fake = labelledGh(['status:blocked']);
  const { path, calls, extension } = setup({ gh: fake.gh });
  await questionWorker(path, [[question(4)], []]);
  const { pi, emit, command } = host('tui', '/repo', ['Give up']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual([...fake.issueLabels], ['status:blocked']);
  assert.deepEqual(fake.repoLabels, ['status:blocked']);
  assert.equal(calls.filter((call) => call.args[1] === 'create').length, 0);
});

test('a user who gives up when the skip label cannot be created sees an error that names it, and the issue keeps its labels', async () => {
  const fake = labelledGh([], true);
  const { path, extension } = setup({ gh: fake.gh });
  await questionWorker(path, [[question(4)], []]);
  const { pi, emit, command, notes } = host('tui', '/repo', ['Give up']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual([...fake.issueLabels], ['status:needs-human']);
  assert.ok(
    notes.some((note) =>
      note.startsWith('next-issue cannot answer: cannot create the label status:blocked'),
    ),
    notes.join('\n'),
  );
});

test('a user who gives up takes the needs-human label off and adds the skip label, then sees the next question', async () => {
  const { path, calls, extension } = setup({ gh: labelledGh(['status:blocked']).gh });
  await questionWorker(path, [[question(4), question(5)], [question(5)], []]);
  const { pi, emit, command, asked } = host('tui', '/repo', ['Give up', undefined]);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(asked, ['#4 Title 4\n\nReason 4', '#5 Title 5\n\nReason 5']);
  assert.deepEqual(calls, [
    {
      args: ['label', 'list', '--repo', 'owner/name', '--limit', '1000', '--json', 'name'],
      cwd: '/repo',
    },
    {
      args: [
        'issue',
        'edit',
        '4',
        '--repo',
        'owner/name',
        '--remove-label',
        'status:needs-human',
        '--add-label',
        'status:blocked',
      ],
      cwd: '/repo',
    },
  ]);
});

test('a user who answers is not shown a question from an older list that arrives first', async () => {
  const { path, extension } = setup();
  await questionWorker(path, [[question(5)], []], [question(4)]);
  const { pi, emit, command, asked } = host('tui', '/repo', [undefined]);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(asked, ['#5 Title 5\n\nReason 5']);
});

test('a user who answers skips a question that was answered elsewhere in the meantime', async () => {
  const { path, calls, extension } = setup();
  await questionWorker(path, [[question(4), question(5)], [], []]);
  const { pi, emit, command, asked } = host('tui', '/repo', ['Retry', 'Retry']);
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(asked, ['#4 Title 4\n\nReason 4']);
  assert.equal(calls.length, 1);
});

test('a user who runs /next-issue answer with no question waiting is told so', async () => {
  const { path, calls, extension } = setup();
  await questionWorker(path, [[]]);
  const { pi, emit, command, notes, asked } = host();
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
  assert.ok(notes.includes('next-issue: no questions waiting'));
});

test('a user sees why the questions could not be read', async () => {
  const { path, extension } = setup();
  const started = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'questions') {
      self.reply({
        type: 'questions-error',
        root: message.root,
        message: 'gh failed',
        ...(message.id === undefined ? {} : { id: message.id }),
      });
    }
  });
  workers.push(started);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('answer');
  assert.ok(notes.includes('next-issue cannot answer: gh failed'));
});
