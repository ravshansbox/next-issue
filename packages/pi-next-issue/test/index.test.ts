import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { tempFolder } from './temp-folder.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: {
    started?: boolean;
    hunting?: boolean;
    watching?: boolean;
    refreshed?: boolean;
    after?: string;
    root: string;
  };
};
type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResult>;

type Overlay = {
  options: unknown;
  closed: boolean;
  screen: () => string;
  press: (key: string) => void;
};
type OverlayFactory = (
  tui: { requestRender: () => void; terminal: { rows: number } },
  theme: unknown,
  keybindings: { matches: (data: string, id: string) => boolean },
  done: (result: unknown) => void,
) => { render: (width: number) => string[]; handleInput: (data: string) => void };

const KEY_IDS: Record<string, string> = {
  up: 'tui.select.up',
  down: 'tui.select.down',
  enter: 'tui.select.confirm',
  escape: 'tui.select.cancel',
  tab: 'tui.input.tab',
  pageUp: 'tui.select.pageUp',
  pageDown: 'tui.select.pageDown',
};
const ROWS = 30;
const KEYBINDINGS = { matches: (data: string, id: string) => KEY_IDS[data] === id };

const shutdowns: Array<() => Promise<void>> = [];

function host(mode = 'tui', cwd = '/repo') {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolExecute>();
  const definitions = new Map<string, { description: string; parameters: unknown }>();
  const completions = new Map<string, (prefix: string) => unknown>();
  const pi = {
    registerTool: (options: {
      name: string;
      description: string;
      parameters: unknown;
      execute: ToolExecute;
    }) => {
      tools.set(options.name, options.execute);
      definitions.set(options.name, options);
    },
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
  const menus: string[][] = [];
  const picks: Array<string | undefined> = [];
  const notes: string[] = [];
  const overlays: Overlay[] = [];
  const plain = (text: string) => /^<dim>(.*)<\/dim>$/s.exec(text)?.[1] ?? text;
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    mode,
    cwd,
    ui: {
      theme,
      custom: (factory: OverlayFactory, options: unknown) =>
        new Promise((resolve) => {
          const overlay: Overlay = {
            options,
            closed: false,
            screen: () => '',
            press: () => {},
          };
          let frame = '';
          const draw = () => {
            frame = component
              .render(200)
              .map((line) => line.replace(/<\/?[a-z]+>/g, ''))
              .join('\n');
          };
          const component = factory(
            { requestRender: draw, terminal: { rows: ROWS } },
            theme,
            KEYBINDINGS,
            (result) => {
              overlay.closed = true;
              resolve(result);
            },
          );
          draw();
          overlay.screen = () => frame;
          overlay.press = (key) => {
            component.handleInput(key);
            draw();
          };
          overlays.push(overlay);
        }),
      setStatus: (key: string, text: string | undefined) => {
        if (key === 'next-issue-questions') {
          waiting.push(text);
          return;
        }
        painted.push(text);
        status.push(text === undefined ? undefined : plain(text));
      },
      select: async (title: string, options: string[]) => {
        asked.push(title);
        menus.push(options);
        return picks.shift();
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
  shutdowns.push(() => emit('session_shutdown'));
  const command = (args = '') => commands.get('next-issue')!(args, ctx);
  const complete = (prefix: string) => completions.get('next-issue')?.(prefix);
  const start = (signal?: AbortSignal, params: unknown = {}) =>
    tools.get('next_issue_start')!('call', params, signal, undefined, ctx);
  const report = () => tools.get('next_issue_status')!('call', {}, undefined, undefined, ctx);
  const refresh = () => tools.get('next_issue_refresh')!('call', {}, undefined, undefined, ctx);
  const hunt = (params: unknown, signal?: AbortSignal) =>
    tools.get('next_issue_hunt')!('call', params, signal, undefined, ctx);
  const watch = (params: unknown, signal?: AbortSignal) =>
    tools.get('next_issue_watch')!('call', params, signal, undefined, ctx);
  const stop = (params: unknown = {}) =>
    tools.get('next_issue_stop')!('call', params, undefined, undefined, ctx);
  return {
    pi,
    ctx,
    status,
    waiting,
    asked,
    menus,
    picks,
    overlays,
    painted,
    widgets,
    notes,
    emit,
    command,
    complete,
    start,
    report,
    refresh,
    hunt,
    watch,
    stop,
    definitions,
  };
}

const KEY = Symbol.for('pi-next-issue');
const workers: FakeWorker[] = [];

afterEach(async () => {
  // Stop each extension's timers first, so that none of them creates a client for the next test.
  for (const shutdown of shutdowns.splice(0)) {
    await shutdown();
  }
  const store = globalThis as Record<symbol, Map<string, WorkerClient> | undefined>;
  for (const client of store[KEY]?.values() ?? []) {
    client.close();
  }
  delete store[KEY];
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

function setup(
  options: {
    version?: string;
    spawn?: (path: string, onExit: (reason: string) => void) => Promise<void>;
    holder?: () => number | undefined;
    startTimeoutMs?: number;
    paths?: Record<string, string>;
  } = {},
) {
  const path = socketPath();
  const spawns: string[] = [];
  const extension = createExtension({
    client: (root) =>
      new WorkerClient({
        socketPath: options.paths?.[root] ?? path,
        version: options.version ?? '1.0.0',
        spawnWorker: (version, onExit) => {
          spawns.push(version);
          void options.spawn?.(path, onExit);
        },
        lockHolder: async () => options.holder?.(),
        startTimeoutMs: options.startTimeoutMs ?? 2000,
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

test('a model sees a next_issue_start tool that takes no args and names no flag', () => {
  const { extension } = setup();
  const { pi, definitions } = host();
  extension(pi as never);
  const start = definitions.get('next_issue_start')!;
  assert.deepEqual((start.parameters as { properties: object }).properties, {});
  assert.doesNotMatch(start.description, /--/);
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
    'A run of /repo is going already, so nothing started: #7 · implement · 3 tools. Asked it to check for new issues now.',
  );
  await until(() => fake.received.some((message) => message.type === 'refresh'));
  assert.deepEqual(
    fake.received.filter((message) => ['start', 'stop', 'refresh'].includes(message.type)),
    [{ type: 'refresh', root: '/repo' }],
  );
});

function refusingRefresh(path: string) {
  return startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'refresh') {
      self.reply({ type: 'error', root: message.root, message: 'unknown message' });
    }
  });
}

test('a model that calls next_issue_start while a run is going on an older worker that refuses refresh still gets the going run reported and sees no error note', async () => {
  const { path, extension } = setup();
  const fake = await refusingRefresh(path);
  workers.push(fake);
  fake.runs['/repo'] = running({ issues: [working(7, { stage: 'implement', tools: 3 })] });
  const { pi, emit, start, notes } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await start();
  assert.deepEqual(result.details, { started: false, root: '/repo' });
  assert.match(String(result.content[0]?.text), /^A run of \/repo is going already/);
  await until(() => fake.received.some((message) => message.type === 'refresh'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(notes, []);
});

test('a model that calls next_issue_stop with no after asks the going run to stop after the running issues and gets told so at once', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0');
  workers.push(fake);
  fake.runs['/repo'] = running();
  const { pi, emit, stop, asked } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await stop();
  assert.deepEqual(result.details, { after: 'issue', root: '/repo' });
  assert.equal(result.content[0]?.text, 'Asked the run of /repo to stop after the running issues.');
  await until(() => fake.received.some((message) => message.type === 'stop'));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'stop'),
    [{ type: 'stop', root: '/repo', after: 'issue' }],
  );
  assert.deepEqual(asked, []);
});

test('a model that calls next_issue_stop with after round or now asks the going run to stop at that point', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0');
  workers.push(fake);
  fake.runs['/repo'] = running();
  const { pi, emit, stop } = host();
  extension(pi as never);
  await emit('session_start');
  const round = await stop({ after: 'round' });
  assert.deepEqual(round.details, { after: 'round', root: '/repo' });
  assert.equal(round.content[0]?.text, 'Asked the run of /repo to stop after the current round.');
  const now = await stop({ after: 'now' });
  assert.deepEqual(now.details, { after: 'now', root: '/repo' });
  assert.equal(now.content[0]?.text, 'Asked the run of /repo to stop at once.');
  await until(() => fake.received.filter((message) => message.type === 'stop').length === 2);
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'stop'),
    [
      { type: 'stop', root: '/repo', after: 'round' },
      { type: 'stop', root: '/repo', after: 'now' },
    ],
  );
});

test('a model that calls next_issue_stop when no run is going gets an error and no stop is sent', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0');
  workers.push(fake);
  const { pi, emit, stop } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(stop(), /no run of \/repo is going/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'stop'),
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
    watching: false,
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
    '#191 · implement · 12 tools\nwatching off\nhunting off\n#190 done\n#189 needs a human\n#188 failed',
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

test('a model that calls next_issue_refresh while a run is going asks that run to check for new issues now and is told so', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, refresh } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await refresh();
  assert.deepEqual(result.details, { refreshed: true, root: '/repo' });
  assert.equal(result.content[0]?.text, 'Asked the run of /repo to check for new issues now.');
  await until(() => fake.received.some((message) => message.type === 'refresh'));
  assert.deepEqual(
    fake.received.filter((message) => ['start', 'stop', 'refresh'].includes(message.type)),
    [{ type: 'refresh', root: '/repo' }],
  );
});

test('a model that calls next_issue_refresh while the going run does not watch is told the run would ignore it and nothing is asked', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ watching: false, issues: [working(7)] });
  const { pi, emit, refresh } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await refresh();
  assert.deepEqual(result.details, { refreshed: false, root: '/repo' });
  assert.equal(
    result.content[0]?.text,
    'The run of /repo does not watch for new issues, so it would ignore the request and nothing was asked.',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => ['start', 'stop', 'refresh'].includes(message.type)),
    [],
  );
});

test('a model that calls next_issue_refresh while the worker has no run of this repository is told no run is going and nothing starts', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/other'] = running({ issues: [working(3)] });
  const { pi, emit, refresh } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await refresh();
  assert.deepEqual(result.details, { refreshed: false, root: '/repo' });
  assert.equal(result.content[0]?.text, 'No run of /repo is going, so nothing was asked.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => ['start', 'stop', 'refresh'].includes(message.type)),
    [],
  );
});

test('a model that calls next_issue_refresh with no worker going is told no run is going and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, refresh } = host();
  extension(pi as never);
  await emit('session_start');
  const result = await refresh();
  assert.deepEqual(result.details, { refreshed: false, root: '/repo' });
  assert.equal(result.content[0]?.text, 'No run of /repo is going, so nothing was asked.');
  assert.equal(spawns.length, 0);
});

test('a model that calls next_issue_stop with no worker going is told no run is going and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, stop } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(stop(), /no run of \/repo is going/);
  assert.equal(spawns.length, 0);
});

test('a model that calls next_issue_hunt with no worker going is told no run is going and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, hunt } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(hunt({ on: true }), /no run of \/repo is going/);
  assert.equal(spawns.length, 0);
});

test('a model that calls next_issue_watch with no worker going is told no run is going and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, watch } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(watch({ on: true }), /no run of \/repo is going/);
  assert.equal(spawns.length, 0);
});

test('a user who runs /next-issue stop, watch on or hunt on with no worker going is told no run is going and no worker starts', async () => {
  const { spawns, extension } = setup();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop');
  await command('watch on');
  await command('hunt on');
  assert.deepEqual(notes, [
    'No run of /repo is going.',
    'No run of /repo is going.',
    'No run of /repo is going.',
  ]);
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

test('a user whose worker goes away mid-run sees the run and the questions count cleared from the footer', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, status, waiting } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issues: [working(7, { startedAt: Date.now() })] }));
  fake.reply({ type: 'questions', root: '/repo', questions: [question(4)] });
  await until(() => status.at(-1)?.includes('#7') === true);
  await until(() => waiting.at(-1) === '<dim>1 question waiting</dim>');
  await fake.close();
  await until(() => status.at(-1) === undefined && waiting.at(-1) === undefined);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(status.at(-1), undefined);
  assert.equal(waiting.at(-1), undefined);
});

test('a user whose worker comes back after it went away sees its run in the footer again', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, status, notes } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issues: [working(7)] }));
  await until(() => status.at(-1)?.includes('#7') === true);
  await fake.close();
  await until(() => status.at(-1) === undefined);
  const back = await worker(path);
  back.update('/repo', running({ issues: [working(8)] }));
  await until(() => status.at(-1)?.includes('#8') === true);
  assert.deepEqual(notes, []);
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

test('a user sees a note per handled issue and a note when the run finishes, and the run line cleared from the footer', async () => {
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
    hunting: false,
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
  assert.equal(status.at(-1), undefined);
});

test('a user whose run stops while pi is open sees a note and the run line cleared from the footer', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issues: [working(7)] }));
  await until(() => status.at(-1)?.includes('#7') === true);
  fake.update('/repo', {
    status: 'stopped',
    hunting: false,
    issues: [],
    handled: [{ issue: 7, outcome: 'done' }],
  });
  await until(() => notes.includes('next-issue stopped'));
  assert.equal(status.at(-1), undefined);
});

test('a user whose run fails while pi is open sees the error in the footer', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  fake.update('/repo', running({ issues: [working(7)] }));
  await until(() => status.at(-1)?.includes('#7') === true);
  fake.update('/repo', {
    status: 'failed',
    hunting: false,
    issues: [],
    handled: [],
    error: 'gh failed',
  });
  await until(() => notes.includes('next-issue failed: gh failed'));
  assert.equal(status.at(-1), 'failed: gh failed');
});

test('a user who opens pi after a run has finished sees no run line in the footer and no notes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'finished',
    hunting: false,
    issues: [],
    handled: [{ issue: 8, outcome: 'needs-human' }],
  };
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.length > 0);
  assert.equal(status.at(-1), undefined);
  assert.deepEqual(notes, []);
});

test('a user who opens pi after a run has stopped sees no run line in the footer and no notes', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'stopped',
    hunting: false,
    issues: [],
    handled: [{ issue: 8, outcome: 'done' }],
  };
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.length > 0);
  assert.equal(status.at(-1), undefined);
  assert.deepEqual(notes, []);
});

test('a model that calls next_issue_status after a run has stopped sees the run and each handled issue with its outcome', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'stopped',
    hunting: false,
    issues: [],
    handled: [{ issue: 8, outcome: 'needs-human' }],
  };
  const { pi, report } = host();
  extension(pi as never);
  const result = await report();
  assert.equal(result.content[0]?.text, 'stopped: 0 done, 1 needs a human\n#8 needs a human');
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

test('a user who runs /next-issue stop round or now asks the worker to stop at that point', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('stop round');
  await command('stop  now ');
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
  await command('stop tool');
  await command('stop --after round');
  await command('stop now later');
  assert.deepEqual(notes, [
    'next-issue cannot stop: stop takes issue, round or now, not tool',
    'next-issue cannot stop: stop takes issue, round or now, not --after',
    'next-issue cannot stop: stop does not take later',
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

test('a user who runs /next-issue start with an argument sees an error and nothing starts', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start --hunt');
  await command('start  --max 3 ');
  assert.deepEqual(notes, [
    'next-issue cannot start: start does not take --hunt',
    'next-issue cannot start: start does not take --max',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'start'),
    false,
  );
});

test('a user who runs /next-issue start while a run is going is told so and nothing starts or stops', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7, { stage: 'implement', tools: 3 })] });
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
  assert.deepEqual(notes, [
    'A run of /repo is going already, so nothing started: #7 · implement · 3 tools. Asked it to check for new issues now.',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'start' || message.type === 'stop'),
    [],
  );
});

test('a user who runs /next-issue with an unknown argument or answer sees the usage without answer and nothing starts or stops', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes, menus } = host();
  extension(pi as never);
  await emit('session_start');
  await command('go');
  await command('answer');
  assert.equal(notes.length, 2);
  for (const note of notes) {
    assert.match(note, /\/next-issue start /);
    assert.match(note, /\/next-issue stop \[issue\|round\|now\]/);
    assert.match(note, /\/next-issue watch on\|off/);
    assert.match(note, /\/next-issue hunt on\|off/);
    assert.match(note, /\/next-issue dashboard/);
    assert.doesNotMatch(note, /answer/);
    assert.doesNotMatch(note, /--/);
  }
  assert.deepEqual(menus, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'start' || message.type === 'stop'),
    [],
  );
});

test('a user who runs /next-issue with no run going is offered Start and Dashboard in a menu, and picking it starts a run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes, menus, picks } = host();
  extension(pi as never);
  await emit('session_start');
  picks.push('Start');
  await command();
  assert.deepEqual(menus, [['Start', 'Dashboard']]);
  assert.deepEqual(notes, []);
  await until(() => fake.received.some((message) => message.type === 'start'));
  assert.deepEqual(
    fake.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo' },
  );
});

test('a user who runs /next-issue with no worker going is offered Start, and picking it starts a worker and a run', async () => {
  let started: FakeWorker | undefined;
  const { spawns, extension } = setup({
    spawn: async (path) => {
      started = await worker(path);
    },
  });
  const { pi, emit, command, menus, picks } = host();
  extension(pi as never);
  await emit('session_start');
  picks.push('Start');
  await command();
  assert.deepEqual(menus, [['Start', 'Dashboard']]);
  assert.equal(spawns.length, 1);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
});

test('a user who runs /next-issue while a run is going is offered Stop and the switches that change the run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ watching: false, hunting: false });
  const { pi, emit, command, menus } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  fake.update('/repo', running({ watching: true, hunting: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await command();
  assert.deepEqual(menus, [
    ['Stop', 'Watch on', 'Hunt on', 'Dashboard'],
    ['Stop', 'Watch off', 'Hunt off', 'Dashboard'],
  ]);
});

test('a user who picks Stop in the /next-issue menu is asked when to stop, and the run is asked to stop at that point', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command, menus, picks, notes } = host();
  extension(pi as never);
  await emit('session_start');
  picks.push('Stop', 'Stop after the current round of each running issue');
  await command();
  picks.push('Stop', 'Stop at once');
  await command();
  picks.push('Stop', 'Stop after the running issues');
  await command();
  assert.deepEqual(menus[1], [
    'Stop after the running issues',
    'Stop after the current round of each running issue',
    'Stop at once',
  ]);
  await until(() => fake.received.filter((message) => message.type === 'stop').length === 3);
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'stop'),
    [
      { type: 'stop', root: '/repo', after: 'round' },
      { type: 'stop', root: '/repo', after: 'now' },
      { type: 'stop', root: '/repo', after: 'issue' },
    ],
  );
  assert.deepEqual(notes, []);
});

test('a user who picks a watch or hunt switch in the /next-issue menu asks the worker to switch it', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ watching: false, hunting: false });
  const { pi, emit, command, picks } = host();
  extension(pi as never);
  await emit('session_start');
  picks.push('Watch on');
  await command();
  picks.push('Hunt on');
  await command();
  await until(
    () =>
      fake.received.filter((message) => message.type === 'watch' || message.type === 'hunt')
        .length === 2,
  );
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'watch' || message.type === 'hunt'),
    [
      { type: 'watch', root: '/repo', on: true },
      { type: 'hunt', root: '/repo', on: true },
    ],
  );
});

test('a user whose going run is on an older worker who picks Watch on in the /next-issue menu sees the same error as the typed command', async () => {
  const { path, extension } = setup({ version: '2.0.0' });
  const fake = await worker(path, '1.0.0');
  fake.runs['/repo'] = running({ watching: false });
  const { pi, emit, command, picks, notes } = host();
  extension(pi as never);
  await emit('session_start');
  picks.push('Watch on');
  await command();
  await command('watch on');
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? '', /^next-issue cannot watch: /);
  assert.equal(notes[0], notes[1]);
});

test('a user who closes the /next-issue menu or its stop menu without a choice sends nothing and sees no note', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running();
  const { pi, emit, command, picks, notes, menus } = host();
  extension(pi as never);
  await emit('session_start');
  await command();
  picks.push('Stop', undefined);
  await command();
  assert.equal(menus.length, 3);
  assert.deepEqual(notes, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    fake.received.filter((message) => ['start', 'stop', 'watch', 'hunt'].includes(message.type)),
    [],
  );
});

async function openDashboard(hosted: ReturnType<typeof host>, args = 'dashboard') {
  const opened = hosted.command(args);
  await until(() => hosted.overlays.length > 0);
  return { overlay: hosted.overlays.at(-1)!, opened };
}

test('a user who runs /next-issue dashboard sees the going run on the Active tab of an overlay, kept up to date, and closes it with Esc', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({
    watching: true,
    open: 5,
    issues: [working(7, { stage: 'implement', tools: 3 })],
    handled: [
      { issue: 3, outcome: 'done' },
      { issue: 4, outcome: 'needs-human' },
    ],
  });
  const hosted = host();
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  const { overlay, opened } = await openDashboard(hosted);
  assert.equal((overlay.options as { overlay: boolean }).overlay, true);
  const screen = overlay.screen();
  assert.match(screen, /Active/);
  assert.match(screen, /Status: running/);
  assert.match(screen, /Watching: on/);
  assert.match(screen, /Hunting: off/);
  assert.match(screen, /Open issues: 5/);
  assert.match(screen, /#7 · implement · 3 tools/);
  assert.match(screen, /#3 done/);
  assert.match(screen, /#4 needs a human/);
  fake.update(
    '/repo',
    running({ watching: true, issues: [working(7, { stage: 'review 1/5', tools: 9 })] }),
  );
  await until(() => overlay.screen().includes('#7 · review 1/5 · 9 tools'), 500);
  overlay.press('escape');
  await opened;
  assert.equal(overlay.closed, true);
});

test('a user who picks Dashboard in the /next-issue menu opens the dashboard overlay', async () => {
  const { path, extension } = setup();
  await worker(path);
  const hosted = host();
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  hosted.picks.push('Dashboard');
  const { overlay, opened } = await openDashboard(hosted, '');
  assert.match(overlay.screen(), /Active/);
  overlay.press('escape');
  await opened;
});

test('a user whose last run failed sees on the Active tab that no run is going, its error and a Start action, and starting shows the new run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = {
    status: 'failed',
    hunting: false,
    issues: [],
    handled: [],
    error: 'gh failed',
  };
  const hosted = host();
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  const { overlay, opened } = await openDashboard(hosted);
  assert.match(overlay.screen(), /No run is going/);
  assert.match(overlay.screen(), /Error: gh failed/);
  assert.match(overlay.screen(), /> Start/);
  overlay.press('enter');
  await until(() => fake.received.some((message) => message.type === 'start'));
  assert.deepEqual(
    fake.received.find((message) => message.type === 'start'),
    { type: 'start', root: '/repo' },
  );
  fake.update('/repo', running({ issues: [working(9)] }));
  await until(() => overlay.screen().includes('Status: running'), 500);
  assert.match(overlay.screen(), /#9/);
  assert.doesNotMatch(overlay.screen(), /No run is going/);
  assert.match(overlay.screen(), /> Stop after the running issues/);
  overlay.press('escape');
  await opened;
});

test('a user who picks each action on the Active tab of a going run sends what the typed stop, watch and hunt commands send', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ watching: false, hunting: false, issues: [working(7)] });
  const hosted = host();
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  const { overlay, opened } = await openDashboard(hosted);
  const screen = overlay.screen();
  for (const action of [
    'Stop after the running issues',
    'Stop after the current round of each running issue',
    'Stop at once',
    'Watch on',
    'Hunt on',
  ]) {
    assert.match(screen, new RegExp(action));
  }
  overlay.press('enter');
  for (let index = 1; index < 5; index += 1) {
    overlay.press('down');
    overlay.press('enter');
  }
  const sent = () =>
    fake.received.filter((message) => ['stop', 'watch', 'hunt'].includes(message.type));
  await until(() => sent().length === 5);
  assert.deepEqual(sent(), [
    { type: 'stop', root: '/repo', after: 'issue' },
    { type: 'stop', root: '/repo', after: 'round' },
    { type: 'stop', root: '/repo', after: 'now' },
    { type: 'watch', root: '/repo', on: true },
    { type: 'hunt', root: '/repo', on: true },
  ]);
  assert.deepEqual(hosted.notes, []);
  overlay.press('escape');
  await opened;
});

function writeRun(root: string, id: string, events: object[], summary?: object) {
  const dir = join(root, '.next-issue', 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    events.map((event) => JSON.stringify({ ts: 'x', runId: id, ...event })).join('\n'),
  );
  if (summary !== undefined) {
    writeFileSync(join(dir, `${id}.summary.json`), JSON.stringify(summary));
  }
}

test('a user who presses Tab on the dashboard sees the past runs newest first, with the start time, end state, issues and summary of the chosen run', async () => {
  const root = tempFolder();
  writeRun(
    root,
    '2026-11-15T19-21-25-787Z',
    [
      { kind: 'run.start' },
      { kind: 'issue.start', issue: 3 },
      { kind: 'issue.end', issue: 3, outcome: 'done', ms: 1000 },
      { kind: 'issue.end', issue: 4, outcome: 'needs-human', reason: 'no fix commit', ms: 1000 },
      { kind: 'run.end', done: 1, needsHuman: 1, failed: 0, skipped: 0, tokens: 1500 },
    ],
    {
      roles: { implementer: { total: 1200, ms: 125000 }, reviewer: { total: 300, ms: 4000 } },
      total: { total: 1500 },
    },
  );
  writeRun(root, '2026-11-16T10-07-19-656Z', [
    { kind: 'run.start' },
    { kind: 'issue.error', issue: 9, error: 'rate limited', ms: 10 },
    { kind: 'run.stop', issue: 9 },
    { kind: 'run.end', done: 0, needsHuman: 0, failed: 1, skipped: 0, tokens: 0 },
  ]);
  const { path, extension } = setup();
  await worker(path);
  const hosted = host('tui', root);
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  const { overlay, opened } = await openDashboard(hosted);
  overlay.press('tab');
  await until(() => overlay.screen().includes('Past runs'), 500);
  const screen = overlay.screen();
  assert.match(screen, /\[Past\]/);
  const newer = screen.indexOf('2026-11-16 10:07:19 UTC · stopped');
  const older = screen.indexOf('2026-11-15 19:21:25 UTC · finished');
  assert.ok(newer >= 0 && older > newer);
  assert.match(screen, /#9 failed: rate limited/);
  assert.match(screen, /No run summary/);
  overlay.press('down');
  const chosen = overlay.screen();
  assert.match(chosen, /Run 2026-11-15 19:21:25 UTC · finished/);
  assert.match(chosen, /#3 done/);
  assert.match(chosen, /#4 needs a human: no fix commit/);
  assert.match(chosen, /Tokens: 1,500/);
  assert.match(chosen, /implementer: 1,200 tokens · 2m05s/);
  assert.match(chosen, /reviewer: 300 tokens · 4s/);
  overlay.press('tab');
  assert.match(overlay.screen(), /No run is going/);
  overlay.press('escape');
  await opened;
});

test('a user with many past runs who chooses an old run on the dashboard sees all its issues and summary within the overlay height, paging through a long run', async () => {
  const root = tempFolder();
  const summary = { roles: { implementer: { total: 900, ms: 60000 } }, total: { total: 900 } };
  const ended = (count: number) => [
    { kind: 'run.start' },
    ...Array.from({ length: count }, (_, index) => ({
      kind: 'issue.end',
      issue: 100 + index,
      outcome: 'done',
      ms: 10,
    })),
    { kind: 'run.end', done: count, needsHuman: 0, failed: 0, skipped: 0, tokens: 900 },
  ];
  for (let day = 1; day <= 20; day += 1) {
    const date = `2026-10-${String(day).padStart(2, '0')}T08-00-00-000Z`;
    writeRun(root, date, ended(day === 2 ? 12 : day === 1 ? 30 : 1), summary);
  }
  const { path, extension } = setup();
  await worker(path);
  const hosted = host('tui', root);
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  const { overlay, opened } = await openDashboard(hosted);
  overlay.press('tab');
  await until(() => overlay.screen().includes('Past runs'), 500);
  const height = Math.floor(ROWS * 0.9);
  for (let press = 0; press < 18; press += 1) {
    overlay.press('down');
  }
  const twelve = overlay.screen();
  assert.ok(twelve.split('\n').length <= height);
  assert.match(twelve, /> 2026-10-02 08:00:00 UTC · finished/);
  assert.match(twelve, /Run 2026-10-02 08:00:00 UTC · finished/);
  for (let index = 0; index < 12; index += 1) {
    assert.match(twelve, new RegExp(`#${100 + index} done`));
  }
  assert.match(twelve, /implementer: 900 tokens · 1m00s/);
  assert.match(twelve, /esc close/);
  overlay.press('down');
  const long = overlay.screen();
  assert.ok(long.split('\n').length <= height);
  assert.match(long, /Run 2026-10-01 08:00:00 UTC · finished/);
  assert.match(long, /esc close/);
  const seen = new Set<string>();
  for (let page = 0; page < 5; page += 1) {
    for (const match of overlay.screen().matchAll(/#(\d+) done/g)) {
      seen.add(match[1]!);
    }
    assert.ok(overlay.screen().split('\n').length <= height);
    overlay.press('pageDown');
  }
  assert.equal(seen.size, 30);
  assert.match(overlay.screen(), /implementer: 900 tokens · 1m00s/);
  overlay.press('escape');
  await opened;
});

test('a user of an rpc client who runs /next-issue dashboard is told it needs the terminal and sees no overlay', async () => {
  const { path, extension } = setup();
  await worker(path);
  const hosted = host('rpc');
  extension(hosted.pi as never);
  await hosted.emit('session_start');
  await hosted.command('dashboard');
  assert.deepEqual(hosted.overlays, []);
  assert.deepEqual(hosted.notes, ['next-issue dashboard needs the terminal UI']);
});

test('a user who runs /next-issue start after a run has stopped starts a new run', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = { status: 'stopped', hunting: false, issues: [], handled: [] };
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

const RUN_NOTE = (action: string) =>
  `next-issue cannot ${action}: a command-line next-issue run (process 4242) is going in this repository. Wait until it ends, or stop it, then try again`;

for (const action of ['start', 'stop']) {
  test(`a user who runs /next-issue ${action} while a command-line run holds the repository is told so at once and no worker starts`, async () => {
    const { spawns, extension } = setup({ holder: () => 4242, startTimeoutMs: 60_000 });
    const { pi, command, notes } = host();
    extension(pi as never);
    const began = Date.now();
    await command(action);
    assert.ok(Date.now() - began < 5000);
    assert.deepEqual(notes, [RUN_NOTE(action)]);
    assert.equal(spawns.length, 0);
  });
}

test('a user whose /next-issue start fails while a retry falls due sees the run in the footer once a worker starts later, with no further command', async () => {
  let held = true;
  const { path, extension } = setup({ holder: () => (held ? 4242 : undefined) });
  const { pi, emit, command, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
  assert.deepEqual(notes, [RUN_NOTE('start')]);
  held = false;
  const fake = await worker(path);
  fake.update('/repo', running({ issues: [working(7)] }));
  await until(() => status.at(-1)?.includes('#7') === true);
});

test('a user whose worker starts slowly while a retry falls due opens one connection to it', async () => {
  let started: FakeWorker | undefined;
  const { extension } = setup({
    startTimeoutMs: 10_000,
    spawn: async (path) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      started = await worker(path);
    },
  });
  const { pi, emit, command } = host();
  extension(pi as never);
  await emit('session_start');
  await command('start');
  await until(() => started?.received.some((message) => message.type === 'start') === true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(started!.received.filter((message) => message.type === 'hello').length, 1);
});

test('a model that calls next_issue_start while a command-line run holds the repository gets that error at once and no worker starts', async () => {
  const { spawns, extension } = setup({ holder: () => 4242, startTimeoutMs: 60_000 });
  const { pi, start } = host();
  extension(pi as never);
  const began = Date.now();
  await assert.rejects(
    start(),
    /^Error: a command-line next-issue run \(process 4242\) is going in this repository/,
  );
  assert.ok(Date.now() - began < 5000);
  assert.equal(spawns.length, 0);
});

test('a user whose worker is closing as the lock is read connects to a new worker once the lock is free', async () => {
  let held = true;
  let started: FakeWorker | undefined;
  const { spawns, extension } = setup({
    holder: () => (held ? 4242 : undefined),
    spawn: async (path) => {
      started = await worker(path);
    },
  });
  setTimeout(() => {
    held = false;
  }, 300);
  const { pi, command } = host();
  extension(pi as never);
  await command('start');
  assert.equal(spawns.length, 1);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
});

test('a user whose worker holds the lock but listens only after a moment connects to it and no new worker starts', async () => {
  const { path, spawns, extension } = setup({ holder: () => 4242, startTimeoutMs: 60_000 });
  let started: FakeWorker | undefined;
  setTimeout(() => {
    void worker(path).then((fake) => {
      started = fake;
    });
  }, 300);
  const { pi, command, notes } = host();
  extension(pi as never);
  await command('start');
  assert.equal(spawns.length, 0);
  assert.deepEqual(notes, []);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
});

test('a user whose spawned worker finds a command-line run and exits sees that run at once', async () => {
  let held = false;
  const { extension } = setup({
    startTimeoutMs: 60_000,
    holder: () => (held ? 4242 : undefined),
    spawn: async (_path, onExit) => {
      held = true;
      setTimeout(() => onExit('next-issue: another worker is running'), 100);
    },
  });
  const { pi, command, notes } = host();
  extension(pi as never);
  const began = Date.now();
  await command('start');
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual(notes, [RUN_NOTE('start')]);
});

test('a user whose spawned worker exits before it listens sees its reason at once', async () => {
  const { extension } = setup({
    startTimeoutMs: 60_000,
    spawn: async (_path, onExit) => {
      setTimeout(
        () => onExit('exit code 1: npm error 404 next-issue@9.9.9 is not in this registry'),
        100,
      );
    },
  });
  const { pi, command, notes } = host();
  extension(pi as never);
  const began = Date.now();
  await command('start');
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual(notes, [
    'next-issue cannot start: the next-issue worker exited before it listened: exit code 1: npm error 404 next-issue@9.9.9 is not in this registry',
  ]);
});

test('a user whose worker starts slowly still connects to it and starts a run', async () => {
  let started: FakeWorker | undefined;
  const { extension } = setup({
    startTimeoutMs: 10_000,
    spawn: async (path) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      started = await worker(path);
    },
  });
  const { pi, command, notes } = host();
  extension(pi as never);
  await command('start');
  assert.deepEqual(notes, []);
  await until(() => started?.received.some((message) => message.type === 'start') === true);
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

function upgradingWorker(path: string, fields: Partial<Progress>) {
  return startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'hello' && message.version === '2.0.0') {
      self.update('/repo', { ...self.runs['/repo']!, status: 'stopping', ...fields });
    }
  });
}

test('a user with a newer extension whose watching run stops for an upgrade sees why and no stopped note, then gets the newer worker and the run started again with the same settings', async () => {
  let fresh: FakeWorker | undefined;
  const { path, spawns, extension } = setup({
    version: '2.0.0',
    spawn: async (socket) => {
      fresh = await worker(socket, '2.0.0');
    },
  });
  const old = await upgradingWorker(path, { upgrade: { from: '1.0.0', to: '2.0.0' } });
  workers.push(old);
  old.runs['/repo'] = running({ watching: true, hunting: true, issues: [working(7)] });
  const { pi, emit, notes, status, report } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === '#7 · stopping to upgrade the worker to 2.0.0');
  assert.deepEqual(notes, ['next-issue: worker 1.0.0 upgrades to 2.0.0 after the running issues']);
  assert.match(
    (await report()).content[0]!.text,
    /^#7 · stopping to upgrade the worker to 2\.0\.0\n/,
  );
  old.update('/repo', { ...old.runs['/repo']!, status: 'stopped', issues: [] });
  await until(() => status.at(-1) === undefined);
  await old.close();
  await until(() => fresh?.received.some((message) => message.type === 'start') === true);
  assert.deepEqual(spawns, ['2.0.0']);
  assert.deepEqual(
    fresh!.received.filter((message) => message.type === 'start'),
    [{ type: 'start', root: '/repo', args: ['--watch', '--hunt'], resume: true }],
  );
  assert.deepEqual(notes, ['next-issue: worker 1.0.0 upgrades to 2.0.0 after the running issues']);
});

test('a user with a newer extension whose run a person stopped gets no new worker and no new run once the old worker closes', async () => {
  const { path, spawns, extension } = setup({ version: '2.0.0' });
  const old = await upgradingWorker(path, {});
  workers.push(old);
  old.runs['/repo'] = running({ watching: true, issues: [working(7)] });
  const { pi, emit, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === '#7 · stopping');
  await old.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(spawns, []);
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
  return { status: 'running', hunting: false, issues: [], handled: [], ...fields };
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

test('a user sees the open-issue count of the latest fetch once, before the running issues, in the footer', () => {
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
    '7 issues · #12 · implement · 3 tools · 41s | #13 · review fix 2/5 · 1 tools',
  );
  assert.equal(
    formatStatus(
      progress({ open: 1, issues: [working(225, { stage: 'implement', tools: 0 })] }),
      now,
    ),
    '1 issue · #225 · implement · 0 tools',
  );
});

test('a user whose run looks for issues sees the open-issue count of the latest fetch in the footer', () => {
  assert.equal(formatStatus(progress({ open: 7 }), now), '7 issues · looking for issues');
});

test('a model sees a finished or stopped run summed up by outcome in the run status', () => {
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

test('a user who types /next-issue followed by nothing or a start of a subcommand is offered the matching subcommands', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const item = (value: string) => ({ value, label: value });
  assert.deepEqual(complete(''), [
    item('start'),
    item('stop'),
    item('watch'),
    item('hunt'),
    item('dashboard'),
  ]);
  assert.deepEqual(complete('d'), [item('dashboard')]);
  assert.deepEqual(complete('h'), [item('hunt')]);
  assert.deepEqual(complete('w'), [item('watch')]);
  assert.deepEqual(complete('st'), [item('start'), item('stop')]);
  assert.equal(complete('an'), null);
  assert.equal(complete('x'), null);
});

test('a user who types /next-issue start followed by a space is offered nothing', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  assert.equal(complete('start '), null);
  assert.equal(complete('start --'), null);
});

test('a user who types /next-issue stop followed by a space is offered issue, round and now', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const issue = {
    value: 'stop issue',
    label: 'issue',
    description: 'Stop after the running issues',
  };
  const round = {
    value: 'stop round',
    label: 'round',
    description: 'Stop after the current round of each running issue',
  };
  const now = { value: 'stop now', label: 'now', description: 'Stop at once' };
  assert.deepEqual(complete('stop '), [issue, round, now]);
  assert.deepEqual(complete('stop r'), [round]);
  assert.equal(complete('stop --'), null);
  assert.equal(complete('stop now '), null);
});

test('a user who types /next-issue watch followed by a space is offered on and off', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const on = {
    value: 'watch on',
    label: 'on',
    description: 'Keep watching for new issues after the current pass',
  };
  const off = {
    value: 'watch off',
    label: 'off',
    description: 'End the going run after the current pass, with hunting off',
  };
  assert.deepEqual(complete('watch '), [on, off]);
  assert.deepEqual(complete('watch of'), [off]);
  assert.equal(complete('watch on '), null);
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
  assert.deepEqual(notes, [
    'next-issue: #5 has a question: Title 5. Ask pi to answer it with the answer-hand-over skill.',
  ]);
});

test('a user sees a note for a question whose title ends in a stop mark with no extra full stop', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, notes } = host();
  extension(pi as never);
  await emit('session_start');
  fake.reply({ type: 'questions', root: '/repo', questions: [] });
  fake.reply({
    type: 'questions',
    root: '/repo',
    questions: [
      { ...question(4), title: 'Fix the parser?' },
      { ...question(5), title: 'Fix the lexer.' },
      { ...question(6), title: 'Fix it now!' },
    ],
  });
  await until(() => notes.length === 3);
  assert.deepEqual(notes, [
    'next-issue: #4 has a question: Fix the parser? Ask pi to answer it with the answer-hand-over skill.',
    'next-issue: #5 has a question: Fix the lexer. Ask pi to answer it with the answer-hand-over skill.',
    'next-issue: #6 has a question: Fix it now! Ask pi to answer it with the answer-hand-over skill.',
  ]);
});

test('a user sees the count drop when a question is answered elsewhere, with no action in this pi', async () => {
  const { path, extension } = setup();
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

test('a user who runs /next-issue hunt on or off while a run is going asks the worker to switch hunting', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('hunt on');
  await command(' hunt  off ');
  await until(() => fake.received.filter((message) => message.type === 'hunt').length === 2);
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'hunt'),
    [
      { type: 'hunt', root: '/repo', on: true },
      { type: 'hunt', root: '/repo', on: false },
    ],
  );
  assert.deepEqual(notes, []);
});

test('a user who runs /next-issue hunt with no value or an unknown one sees an error and nothing is sent', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('hunt');
  await command('hunt yes');
  await command('hunt on now');
  assert.deepEqual(notes, [
    'next-issue cannot hunt: hunt takes on or off',
    'next-issue cannot hunt: hunt takes on or off, not yes',
    'next-issue cannot hunt: hunt does not take now',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'hunt'),
    false,
  );
});

test('a user who runs /next-issue hunt on with no run going is told so and nothing is sent', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('hunt on');
  assert.deepEqual(notes, ['No run of /repo is going.']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'hunt'),
    false,
  );
});

test('a user whose worker refuses to switch hunting sees why', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'hunt') {
      self.reply({ type: 'error', root: message.root, message: 'the worker is restarting' });
    }
  });
  workers.push(fake);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('hunt on');
  await until(() => notes.length > 0);
  assert.deepEqual(notes, ['next-issue cannot hunt: the worker is restarting']);
});

test('a user sees a note when hunting of the going run turns on or off', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ hunting: false });
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === 'looking for issues');
  fake.update('/repo', running({ hunting: true }));
  await until(() => notes.length === 1);
  fake.update('/repo', running({ hunting: false }));
  await until(() => notes.length === 2);
  assert.deepEqual(notes, ['next-issue: hunting on', 'next-issue: hunting off']);
  assert.ok(status.every((line) => !line?.includes('hunting')));
});

test('a user who types /next-issue hunt followed by a space is offered on and off', () => {
  const { extension } = setup();
  const { pi, complete } = host();
  extension(pi as never);
  const on = { value: 'hunt on', label: 'on', description: 'Hunt for bugs in the going run' };
  const off = {
    value: 'hunt off',
    label: 'off',
    description: 'Start no new hunt in the going run, and let a going hunt finish',
  };
  assert.deepEqual(complete('hunt '), [on, off]);
  assert.deepEqual(complete('hunt of'), [off]);
  assert.equal(complete('hunt on '), null);
});

function huntWorker(path: string) {
  return startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type !== 'hunt') {
      return;
    }
    if (self.runs[message.root]?.status !== 'running') {
      self.reply({ type: 'error', root: message.root, message: 'no run is going' });
    } else {
      self.update(message.root, { ...self.runs[message.root]!, hunting: message.on });
    }
  });
}

test('a model that calls next_issue_hunt switches hunting of the going run and gets the new setting', async () => {
  const { path, extension } = setup();
  const fake = await huntWorker(path);
  workers.push(fake);
  fake.runs['/repo'] = running({ hunting: false });
  const { pi, emit, hunt } = host();
  extension(pi as never);
  await emit('session_start');
  const on = await hunt({ on: true });
  assert.deepEqual(on.details, { hunting: true, root: '/repo' });
  assert.equal(on.content[0]?.text, 'Hunting is on for the run of /repo.');
  const off = await hunt({ on: false });
  assert.deepEqual(off.details, { hunting: false, root: '/repo' });
  assert.equal(
    off.content[0]?.text,
    'Hunting is off for the run of /repo. A hunt that is going finishes, and no new hunt starts.',
  );
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'hunt'),
    [
      { type: 'hunt', root: '/repo', on: true },
      { type: 'hunt', root: '/repo', on: false },
    ],
  );
});

test('a model that calls next_issue_hunt gets the error when the worker refuses or no run is going', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'hunt') {
      self.reply({ type: 'error', root: message.root, message: 'the worker is restarting' });
    }
  });
  workers.push(fake);
  const { pi, emit, hunt } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(hunt({ on: true }), /no run of \/repo is going/);
  fake.update('/repo', running());
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(hunt({ on: true }), /the worker is restarting/);
});

test('a user who runs /next-issue watch on or off while a run is going asks the worker to switch watching', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ issues: [working(7)] });
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('watch on');
  await command(' watch  off ');
  await until(() => fake.received.filter((message) => message.type === 'watch').length === 2);
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'watch'),
    [
      { type: 'watch', root: '/repo', on: true },
      { type: 'watch', root: '/repo', on: false },
    ],
  );
  assert.deepEqual(notes, []);
});

test('a user who runs /next-issue watch with no value or an unknown one sees an error and nothing is sent', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('watch');
  await command('watch yes');
  await command('watch on now');
  assert.deepEqual(notes, [
    'next-issue cannot watch: watch takes on or off',
    'next-issue cannot watch: watch takes on or off, not yes',
    'next-issue cannot watch: watch does not take now',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'watch'),
    false,
  );
});

test('a user whose worker refuses to switch watching sees why', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'watch') {
      self.reply({ type: 'error', root: message.root, message: 'no run is going' });
    }
  });
  workers.push(fake);
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('watch on');
  await until(() => notes.length > 0);
  assert.deepEqual(notes, ['next-issue cannot watch: no run is going']);
});

test('a user sees a note when watching of the going run turns on or off', async () => {
  const { path, extension } = setup();
  const fake = await worker(path);
  fake.runs['/repo'] = running({ watching: false });
  const { pi, emit, notes, status } = host();
  extension(pi as never);
  await emit('session_start');
  await until(() => status.at(-1) === 'looking for issues');
  fake.update('/repo', running({ watching: true }));
  await until(() => notes.length === 1);
  fake.update('/repo', running({ watching: false }));
  await until(() => notes.length === 2);
  assert.deepEqual(notes, ['next-issue: watching on', 'next-issue: watching off']);
});

function watchWorker(path: string) {
  return startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type !== 'watch') {
      return;
    }
    if (self.runs[message.root]?.status !== 'running') {
      self.reply({ type: 'error', root: message.root, message: 'no run is going' });
    } else {
      self.update(message.root, { ...self.runs[message.root]!, watching: message.on });
    }
  });
}

test('a model that calls next_issue_watch switches watching of the going run and gets the new setting', async () => {
  const { path, extension } = setup();
  const fake = await watchWorker(path);
  workers.push(fake);
  fake.runs['/repo'] = running({ watching: false });
  const { pi, emit, watch } = host();
  extension(pi as never);
  await emit('session_start');
  const on = await watch({ on: true });
  assert.deepEqual(on.details, { watching: true, root: '/repo' });
  assert.equal(
    on.content[0]?.text,
    'The run of /repo keeps watching for new issues after the current pass.',
  );
  const off = await watch({ on: false });
  assert.deepEqual(off.details, { watching: false, root: '/repo' });
  assert.equal(
    off.content[0]?.text,
    'The run of /repo ends after the current pass, with hunting off.',
  );
  assert.deepEqual(
    fake.received.filter((message) => message.type === 'watch'),
    [
      { type: 'watch', root: '/repo', on: true },
      { type: 'watch', root: '/repo', on: false },
    ],
  );
});

test('a model that calls next_issue_watch gets the error when the worker refuses or no run is going', async () => {
  const { path, extension } = setup();
  const fake = await startFakeWorker(path, '1.0.0', (self, message) => {
    if (message.type === 'watch') {
      self.reply({ type: 'error', root: message.root, message: 'the worker is restarting' });
    }
  });
  workers.push(fake);
  const { pi, emit, watch } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(watch({ on: true }), /no run of \/repo is going/);
  fake.update('/repo', running());
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(watch({ on: true }), /the worker is restarting/);
});

test('a user whose going run is on an older worker who runs /next-issue watch or hunt sees that the run must start again and nothing is sent', async () => {
  const { path, extension } = setup({ version: '2.0.0' });
  const fake = await worker(path, '1.0.0');
  fake.runs['/repo'] = running();
  const { pi, emit, command, notes } = host();
  extension(pi as never);
  await emit('session_start');
  await command('watch on');
  await command('hunt on');
  assert.deepEqual(notes, [
    'next-issue cannot watch: the worker of the going run is older than this extension, so it cannot switch watching. Stop the run, then start it again',
    'next-issue cannot hunt: the worker of the going run is older than this extension, so it cannot switch hunting. Stop the run, then start it again',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.received.some((message) => message.type === 'watch' || message.type === 'hunt'),
    false,
  );
});

test('a model whose going run is on an older worker that calls next_issue_watch or next_issue_hunt gets an error at once and nothing is sent', async () => {
  const { path, extension } = setup({ version: '2.0.0' });
  const fake = await worker(path, '1.0.0');
  fake.runs['/repo'] = running();
  const { pi, emit, watch, hunt } = host();
  extension(pi as never);
  await emit('session_start');
  await assert.rejects(
    watch({ on: true }),
    /older than this extension, so it cannot switch watching/,
  );
  await assert.rejects(
    hunt({ on: true }),
    /older than this extension, so it cannot switch hunting/,
  );
  assert.equal(
    fake.received.some((message) => message.type === 'watch' || message.type === 'hunt'),
    false,
  );
});

test('a user whose going run hunts sees no hunting marker in the footer', () => {
  assert.equal(formatStatus(progress({ hunting: true }), now), 'looking for issues');
  assert.equal(
    formatStatus(progress({ hunting: true, issues: [working(4, { stage: 'implement' })] }), now),
    '#4 · implement · 0 tools',
  );
});
