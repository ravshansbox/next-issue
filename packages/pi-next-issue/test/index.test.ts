import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createExtension, formatStatus } from '../index.ts';
import { Runner } from '../src/runner.ts';
import { CONFIG, fake, issue } from './fake.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

function host(mode = 'tui') {
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
    cwd: '/repo',
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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

const KEY = Symbol.for('pi-next-issue');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

test('a user who runs /next-issue sees the run in the footer and a note per merged issue', async () => {
  const { ports } = fake({ issues: [issue(7)] });
  const extension = createExtension(async () => new Runner(ports, CONFIG));
  const { pi, status, notes, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  assert.ok(status.some((text) => text?.startsWith('next-issue #7 · review 1/2')));
  assert.ok(notes.includes('next-issue: #7 merged'));
  assert.equal(status.at(-1), 'next-issue · finished: 1 merged');
  await emit('session_shutdown', { reason: 'quit' });
});

test('a user who runs /next-issue sees the footer status and the last tool line in the dim colour of the theme', async () => {
  let release = () => {};
  const { ports } = fake({
    issues: [issue(7)],
    onWork: (task) => {
      task.onTool('bash npm test');
      return new Promise<void>((resolve) => (release = resolve));
    },
  });
  const extension = createExtension(async () => new Runner(ports, CONFIG));
  const { pi, painted, widgets, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  assert.match(painted.at(-1) ?? '', /^<dim>next-issue #7 · implement · 1 tools · \d+s<\/dim>$/);
  assert.deepEqual(widgets.at(-1), ['<dim>↳ bash npm test</dim>']);
  release();
  await settle();
  assert.equal(painted.at(-1), '<dim>next-issue · finished: 1 merged</dim>');
  await emit('session_shutdown', { reason: 'quit' });
});

test('a user of an rpc client who runs /next-issue gets the footer status and the last tool line without colour codes', async () => {
  let release = () => {};
  const { ports } = fake({
    issues: [issue(7)],
    onWork: (task) => {
      task.onTool('bash npm test');
      return new Promise<void>((resolve) => (release = resolve));
    },
  });
  const extension = createExtension(async () => new Runner(ports, CONFIG));
  const { pi, painted, widgets, emit, command } = host('rpc');
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  assert.match(painted.at(-1) ?? '', /^next-issue #7 · implement · 1 tools · \d+s$/);
  assert.deepEqual(widgets.at(-1), ['↳ bash npm test']);
  release();
  await settle();
  assert.equal(painted.at(-1), 'next-issue · finished: 1 merged');
  await emit('session_shutdown', { reason: 'quit' });
});

test('a user who runs /next-issue while a run is going stops it and keeps the summary in the footer', async () => {
  let release = () => {};
  let launches = 0;
  const { ports, states } = fake({
    issues: [issue(7)],
    onWork: () => new Promise<void>((resolve) => (release = resolve)),
  });
  const extension = createExtension(async () => {
    launches += 1;
    return new Runner(ports, CONFIG);
  });
  const { pi, status, notes, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  await command();
  assert.equal(status.at(-1), 'next-issue #7 · stopping');
  await command();
  release();
  await settle();
  assert.equal(launches, 1);
  assert.ok(notes.includes('next-issue stopped'));
  assert.equal(status.at(-1), 'next-issue · stopped: 0 merged');
  assert.equal(states.get(7)?.phase, 'implement');
});

test('a user who runs /next-issue after a run has stopped starts a new run', async () => {
  let release = () => {};
  let launches = 0;
  const { ports } = fake({
    issues: [issue(7)],
    onWork: () => new Promise<void>((resolve) => (release = resolve)),
  });
  const extension = createExtension(async () => {
    launches += 1;
    return new Runner(ports, CONFIG);
  });
  const { pi, status, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  await command();
  release();
  await settle();
  await command();
  await settle();
  assert.equal(launches, 2);
  assert.ok(status.at(-1)?.startsWith('next-issue #7 · implement'));
  release();
  await settle();
  await emit('session_shutdown', { reason: 'quit' });
});

test('a user who starts a second run while the first is still launching is told so', async () => {
  const pending: Array<() => void> = [];
  let launches = 0;
  const { ports } = fake({ issues: [] });
  const extension = createExtension(async () => {
    launches += 1;
    await new Promise<void>((resolve) => pending.push(resolve));
    return new Runner(ports, CONFIG);
  });
  const { pi, notes, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  const first = command();
  const second = command();
  await settle();
  for (const finishLaunch of pending) finishLaunch();
  await Promise.all([first, second]);
  await settle();
  assert.equal(launches, 1);
  assert.ok(notes.includes('next-issue is starting already'));
  await emit('session_shutdown', { reason: 'quit' });
});

test('a run keeps going in a new session and shows up there', async () => {
  let release = () => {};
  const { ports } = fake({
    issues: [issue(7)],
    onWork: () => new Promise<void>((resolve) => (release = resolve)),
  });
  const extension = createExtension(async () => new Runner(ports, CONFIG));
  const first = host();
  extension(first.pi as never);
  await first.emit('session_start');
  await first.command();
  await settle();
  await first.emit('session_shutdown', { reason: 'new' });
  const second = host();
  extension(second.pi as never);
  await second.emit('session_start');
  assert.ok(second.status.at(-1)?.startsWith('next-issue #7 · implement'));
  release();
  await settle();
  assert.equal(second.status.at(-1), 'next-issue · finished: 1 merged');
  await second.emit('session_shutdown', { reason: 'quit' });
});

test('a user who quits pi stops the run', async () => {
  let release = () => {};
  const { ports, states } = fake({
    issues: [issue(7)],
    onWork: () => new Promise<void>((resolve) => (release = resolve)),
  });
  let runner: Runner | undefined;
  const extension = createExtension(async () => (runner = new Runner(ports, CONFIG)));
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  await settle();
  await emit('session_shutdown', { reason: 'quit' });
  release();
  await settle();
  assert.equal(runner?.progress.status, 'stopped');
  assert.equal(states.get(7)?.phase, 'implement');
});

test('a user sees why a run could not start', async () => {
  const extension = createExtension(async () => {
    throw new Error('not a git repository');
  });
  const { pi, notes, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  assert.ok(notes.includes('next-issue cannot start: not a git repository'));
});

test('a user sees the issue, the stage, the tool count and the time spent in the footer', () => {
  const text = formatStatus(
    { status: 'running', issue: 12, stage: 'checks', tools: 37, issueStartedAt: 0, handled: [] },
    252_000,
  );
  assert.equal(text, 'next-issue #12 · checks · 37 tools · 4m12s');
});

test('a user sees a finished run summed up by outcome in the footer', () => {
  const text = formatStatus(
    {
      status: 'finished',
      tools: 0,
      handled: [
        { issue: 1, outcome: 'merged' },
        { issue: 2, outcome: 'needs-human' },
        { issue: 3, outcome: 'merged' },
      ],
    },
    0,
  );
  assert.equal(text, 'next-issue · finished: 2 merged, 1 needs a human');
});

test('a user sees the error of a failed run in the footer', () => {
  const text = formatStatus({ status: 'failed', tools: 0, handled: [], error: 'gh is missing' }, 0);
  assert.equal(text, 'next-issue · failed: gh is missing');
});
