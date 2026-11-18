import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

const ROOT = '/repo';

const ABOVE_PROMPT = {
  plugin: 'next-issue',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const PANE = {
  plugin: 'next-issue',
  component: 'Pane',
  requestId: 'next-issue',
  props: {
    title: 'next-issue',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

type Message = Record<string, unknown>;

const QUESTION = {
  issue: 9,
  title: 'Stuck issue',
  reason: 'local checks failed: npm test',
  url: 'https://github.com/o/r/issues/9#issuecomment-1',
  repo: 'o/r',
  labels: { needsHuman: 'status:needs-human', skip: 'status:blocked', ready: 'status:todo' },
};

const RUNNING = {
  status: 'running',
  hunting: false,
  watching: true,
  issues: [{ issue: 7, stage: 'implement', tools: 3 }],
  handled: [{ issue: 5, outcome: 'done' }],
  open: 4,
};

function ran(stdout = '', exitCode = 0) {
  return {
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  };
}

function world(on: On, runs: Record<string, unknown> = {}, questions = [QUESTION]) {
  const state = {
    runs,
    posted: [] as Message[],
    commands: [] as string[][],
    toasts: [] as string[],
  };
  on('session.cwd', () => ({ value: ROOT }));
  on('fs.read', () => ({ value: JSON.stringify({ version: '1.2.3' }) }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }));
  on('ui.toast', (_, e) => {
    state.toasts.push(String((e as { text: unknown }).text));
    return { value: undefined };
  });
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv;
    state.commands.push(argv);
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return ran(ROOT + '\n');
    if (argv[0] === 'git') return ran(`worktree ${ROOT}\nHEAD x\n`);
    if (argv[0] === 'gh' && argv[1] === 'label')
      return ran(JSON.stringify([{ name: 'status:blocked' }]));
    return ran();
  });
  on('http.fetch', (_, e) => {
    const init = (e as { init?: { method?: string; body?: string } }).init ?? {};
    const replies: Message[] = [];
    if (init.method === 'POST') {
      const message = JSON.parse(init.body ?? '{}') as Message;
      state.posted.push(message);
      if (message['type'] === 'start') {
        state.runs = { [ROOT]: { ...RUNNING, issues: [], handled: [] } };
      } else if (message['type'] === 'stop') {
        replies.push({ type: 'stopping', root: ROOT, waiting: true, hunting: false });
      } else if (message['type'] === 'questions') {
        replies.push({
          type: 'questions',
          root: ROOT,
          questions: state.posted.some((item) => item['type'] === 'refresh') ? [] : questions,
        });
      }
    } else {
      replies.push({ type: 'hello', version: '1.2.3' });
    }
    const text = JSON.stringify([...replies, { type: 'runs', runs: state.runs }]);
    return { value: { status: 200, ok: true, headers: {}, text } };
  });
  return state;
}

test('a person who starts a session gets the /next-issue command and the six next-issue tools', async ($, on) => {
  const tools: string[] = [];
  const commands: string[] = [];
  on('tool.register', (_, e) => {
    tools.push(String((e as { name: unknown }).name));
    return { value: { tool: `mcp__next-issue__${String((e as { name: unknown }).name)}` } };
  });
  on('command.register', (_, e) => {
    commands.push(String((e as { name: unknown }).name));
    return { value: { command: String((e as { name: unknown }).name) } };
  });
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false });
  expect(commands).toEqual(['next-issue']);
  expect(tools).toEqual([
    'next_issue_start',
    'next_issue_refresh',
    'next_issue_watch',
    'next_issue_hunt',
    'next_issue_stop',
    'next_issue_status',
  ]);
});

test('a model that asks for the status of a going run gets its status line, watching, hunting and handled issues', async ($, on) => {
  world(on, { [ROOT]: RUNNING });
  const reply = await $.tool.run({ tool: 'mcp__next-issue__next_issue_status' });
  expect(reply.result).toBe('4 issues · #7 · implement\nwatching on\nhunting off\n#5 done');
});

test('a model that stops a run when none is going gets an error that says so', async ($, on) => {
  world(on);
  const reply = await $.tool.run({ tool: 'mcp__next-issue__next_issue_stop', after: 'now' });
  expect(reply.deny).toBe('no run of /repo is going');
});

test('a model that stops a going run at once gets the answer and the worker gets the stop', async ($, on) => {
  const state = world(on, { [ROOT]: RUNNING });
  const reply = await $.tool.run({ tool: 'mcp__next-issue__next_issue_stop', after: 'now' });
  expect(reply.result).toBe('Asked the run of /repo to stop at once.');
  expect(state.posted.at(-1)).toEqual({ type: 'stop', root: ROOT, after: 'now' });
});

test('a person who opens the dashboard during a run sees its issues and the stop choices', async ($, on) => {
  world(on, { [ROOT]: RUNNING });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  const opened = await $.command.run({ command: 'next-issue' });
  expect(opened.text).toBe('Opened the next-issue dashboard.');
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect((await ui.find({ type: 'Button', key: 'running:7' }))?.text).toBe('#7 · implement');
  expect((await ui.find({ type: 'Button', key: 'handled:0' }))?.text).toBe('#5 done');
  expect((await ui.find({ type: 'Button', key: 'action:stop now' }))?.text).toBe('Stop at once');
  expect((await ui.find({ type: 'Button', key: 'action:watch off' }))?.text).toBe('Watch off');
  await ui.unmount();
});

test('a person who presses Start in the dashboard starts a run and sees a toast that says so', async ($, on) => {
  const state = world(on);
  on('ui.open', () => ({ value: { isPlaced: true } }));
  await $.command.run({ command: 'next-issue' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'action:start' });
  expect(state.posted.at(-1)).toEqual({ type: 'start', root: ROOT });
  expect(state.toasts).toEqual(['Started a next-issue run of /repo.']);
  await ui.unmount();
});

test('a person with no surface for the dashboard who runs /next-issue gets the status of the run', async ($, on) => {
  world(on, { [ROOT]: RUNNING });
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }));
  on('tool.call', () => ({ deny: 'no one to ask' }));
  const opened = await $.command.run({ command: 'next-issue' });
  expect(opened.text).toBe('4 issues · #7 · implement\nwatching on\nhunting off\n#5 done');
});

test('a person who retries a hand-over in the dashboard swaps its label for the ready label', async ($, on) => {
  const state = world(on, { [ROOT]: RUNNING });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  await $.command.run({ command: 'next-issue' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'tab:Hand-overs' });
  expect((await ui.find({ type: 'Text', text: /Stuck issue/ }))?.text).toBe('#9 Stuck issue');
  await ui.press({ key: 'retry:9' });
  expect(state.commands.filter((argv) => argv[0] === 'gh')).toEqual([
    [
      'gh',
      'issue',
      'edit',
      '--repo',
      'o/r',
      '9',
      '--remove-label',
      'status:needs-human',
      '--add-label',
      'status:todo',
    ],
  ]);
  expect((await ui.find({ type: 'Text', text: /Retried #9/ }))?.text).toBe(
    'Retried #9. Asked the run of /repo to check for new issues now.',
  );
  await ui.unmount();
});

test('a person who answers a hand-over with guidance that starts with a harness heading sees why it does not count', async ($, on) => {
  const state = world(on, { [ROOT]: RUNNING });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  await $.command.run({ command: 'next-issue' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'tab:Hand-overs' });
  await ui.press({ key: 'guide:9' });
  await ui.input({ key: 'guidance:9', text: '### Review: try again' });
  expect((await ui.find({ type: 'Text', text: /must not start/ }))?.text).toBe(
    'The guidance must not start with ### Review:, since it would not count as an answer.',
  );
  expect(state.commands.filter((argv) => argv[0] === 'gh')).toEqual([]);
  await ui.unmount();
});

test('a person in an interactive session sees the run and the waiting questions in the row above the prompt', async ($, on) => {
  world(on, { [ROOT]: RUNNING });
  const clock = mock.clock(on);
  on('tool.register', (_, e) => ({
    value: { tool: `mcp__next-issue__${String((e as { name: unknown }).name)}` },
  }));
  on('command.register', () => ({ value: { command: 'next-issue' } }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true });
  await clock.advance(1000);
  const ui = await $.ui.mount({ ...ABOVE_PROMPT, surface: 'terminal' });
  expect((await ui.find({ type: 'Text' }))?.text).toBe(
    '4 issues · #7 · implement · 1 question waiting',
  );
  await ui.unmount();
});

test('a person who sees a survey above the prompt sees no next-issue row there', async ($, on) => {
  world(on, { [ROOT]: RUNNING });
  const clock = mock.clock(on);
  on('tool.register', (_, e) => ({
    value: { tool: `mcp__next-issue__${String((e as { name: unknown }).name)}` },
  }));
  on('command.register', () => ({ value: { command: 'next-issue' } }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true });
  await clock.advance(1000);
  const ui = await $.ui.mount({
    ...ABOVE_PROMPT,
    props: { ...ABOVE_PROMPT.props, hasSurvey: true },
    surface: 'terminal',
  });
  expect(await ui.find({ type: 'Text' })).toBeUndefined();
  await ui.unmount();
});

test('a person in an interactive session with no run going sees no next-issue row above the prompt', async ($, on) => {
  world(on, {}, []);
  const clock = mock.clock(on);
  on('tool.register', (_, e) => ({
    value: { tool: `mcp__next-issue__${String((e as { name: unknown }).name)}` },
  }));
  on('command.register', () => ({ value: { command: 'next-issue' } }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true });
  await clock.advance(1000);
  const ui = await $.ui.mount({ ...ABOVE_PROMPT, surface: 'terminal' });
  expect(await ui.find({ type: 'Text' })).toBeUndefined();
  await ui.unmount();
});
