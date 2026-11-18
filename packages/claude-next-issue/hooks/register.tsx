import type { EngineInterface, Register } from 'claude-code';
import { act, answer } from '../src/actions.ts';
import {
  handOverNote,
  runLines,
  statusLine,
  TABS,
  type Tab,
  upcomingLines,
} from '../src/dashboard.ts';
import { issueDetail } from '../src/detail.ts';
import { errorText } from '../src/errors.ts';
import { type Answer, guidanceProblem } from '../src/hand-overs.ts';
import { type Host, must } from '../src/host.ts';
import { dashboardActions, menuChoices, STOP_CHOICES } from '../src/menu.ts';
import { issueNote, type PastRun, pastRuns, runLine, summaryLines } from '../src/past.ts';
import { workerLaunch } from '../src/paths.ts';
import {
  going,
  type Question,
  STOP_POINTS,
  type StopPoint,
  type Upcoming,
} from '../src/protocol.ts';
import { handledNote, issueLine } from '../src/status.ts';
import { TOOLS } from '../src/tool-specs.ts';
import { refreshRun, startRun, statusOf, stopRun, switchRun } from '../src/tools.ts';
import { WorkerClient } from '../src/worker.ts';

const PANE = 'next-issue';
const READ_LIMIT = 4 * 1024 * 1024;
const TICK_MS = 1000;
const QUESTIONS_MS = 60_000;

type Detail = { issue: number; runId: string | undefined; lines?: string[] | undefined };

type View = {
  tab: Tab;
  past?: PastRun[] | undefined;
  chosenRun: number;
  detail?: Detail | undefined;
  upcoming?: Upcoming | string | undefined;
  guiding?: Question | undefined;
  problem?: string | undefined;
  outcome?: string | undefined;
  busy: boolean;
};

function hostOf($: EngineInterface): Host {
  return {
    request: async (socketPath, method, body) => {
      const response = await $.http.fetch('http://localhost/', {
        method,
        socketPath,
        ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
      });
      return { status: response.status, text: response.text };
    },
    run: async (argv, options) => {
      const result = await $.process.run(argv, {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        timeoutMs: options?.timeoutMs ?? 30_000,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    pause: async (ms) => {
      await $.process.run(['sleep', String(ms / 1000)]);
    },
    read: async (path) => {
      try {
        const { size } = await $.fs.stat(path);
        const offset = Math.max(0, size - READ_LIMIT);
        return await $.fs.read(path, { offset, length: size - offset });
      } catch {
        return undefined;
      }
    },
    list: async (dir) => (await $.fs.list(dir).catch(() => [])).map((entry) => entry.name),
  };
}

async function repoRoot(host: Host, cwd: string): Promise<string> {
  const top = await must(host, ['git', 'rev-parse', '--show-toplevel'], cwd);
  const list = await must(host, ['git', 'worktree', 'list', '--porcelain'], cwd);
  const [first = '', second = ''] = list.split('\n');
  return first.startsWith('worktree ') && second !== 'bare' ? first.slice('worktree '.length) : top;
}

async function pluginVersion($: EngineInterface, host: Host): Promise<string> {
  const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as {
    version?: string;
  };
  const version = manifest.version ?? '0.0.0';
  if (version !== '0.0.0') {
    return version;
  }
  const latest = await host
    .run(['npm', 'view', 'next-issue', 'version'], { timeoutMs: 15_000 })
    .catch(() => undefined);
  const found = latest?.exitCode === 0 ? latest.stdout.trim() : '';
  return /^\d+\.\d+\.\d+/.test(found) ? found : version;
}

let client: Promise<WorkerClient> | undefined;
let host: Host | undefined;
let ticking = false;
let lastQuestions = 0;
let runText: string | undefined;
const view: View = { tab: 'Active', chosenRun: 0, busy: false };

function clientFor($: EngineInterface, cwd: string): Promise<WorkerClient> {
  host ??= hostOf($);
  const used = host;
  client ??= (async () => {
    const [root, version] = await Promise.all([repoRoot(used, cwd), pluginVersion($, used)]);
    return new WorkerClient({ root, version, launch: workerLaunch(version), host: used });
  })();
  client.catch(() => {
    client = undefined;
  });
  return client;
}

async function tick($: EngineInterface, cwd: string): Promise<void> {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    const worker = await clientFor($, cwd).catch(() => undefined);
    if (worker === undefined) {
      return;
    }
    const wasConnected = worker.connected;
    await worker.poll();
    if (worker.connected && (!wasConnected || Date.now() - lastQuestions >= QUESTIONS_MS)) {
      lastQuestions = Date.now();
      await worker.askQuestions();
    }
    runText = statusLine(worker.progress, worker.questions, Date.now());
    $.ui.invalidate('ui.render');
  } finally {
    ticking = false;
  }
}

function redraw($: EngineInterface): void {
  $.ui.invalidate('ui.render');
}

async function loadDetail($: EngineInterface, worker: WorkerClient, detail: Detail): Promise<void> {
  const lines = await issueDetail(hostOf($), worker.root, detail.issue, detail.runId).catch(
    (error: unknown) => [`Could not read #${detail.issue}: ${errorText(error)}`],
  );
  if (view.detail === detail) {
    detail.lines = lines;
    redraw($);
  }
}

function openDetail($: EngineInterface, worker: WorkerClient, issue: number, runId?: string): void {
  const detail: Detail = { issue, runId };
  view.detail = detail;
  redraw($);
  void loadDetail($, worker, detail);
}

function closeDetail($: EngineInterface): void {
  view.detail = undefined;
  redraw($);
}

function chooseRun($: EngineInterface, index: number): void {
  view.chosenRun = index;
  redraw($);
}

function guide($: EngineInterface, question: Question): void {
  view.guiding = question;
  view.problem = undefined;
  redraw($);
}

function submitGuidance(
  $: EngineInterface,
  worker: WorkerClient,
  question: Question,
  text: string,
): void {
  view.problem = guidanceProblem(text);
  if (view.problem === undefined) {
    reply($, worker, question, { kind: 'retry', guidance: text.trim() });
  } else {
    redraw($);
  }
}

function show($: EngineInterface, worker: WorkerClient, tab: Tab): void {
  view.tab = tab;
  view.detail = undefined;
  view.guiding = undefined;
  view.problem = undefined;
  if (tab === 'Past') {
    view.past = undefined;
    view.chosenRun = 0;
    void pastRuns(hostOf($), worker.root)
      .catch(() => [])
      .then((runs) => {
        view.past = runs;
        redraw($);
      });
  } else if (tab === 'Hand-overs') {
    view.outcome = undefined;
    void worker.askQuestions().then(() => redraw($));
  } else if (tab === 'Upcoming') {
    view.upcoming = undefined;
    void worker
      .upcoming()
      .catch((error: unknown) => errorText(error))
      .then((value) => {
        view.upcoming = value;
        redraw($);
      });
  }
  redraw($);
}

function reply($: EngineInterface, worker: WorkerClient, question: Question, given: Answer): void {
  view.guiding = undefined;
  view.problem = undefined;
  view.busy = true;
  view.outcome = `Answering #${question.issue}…`;
  redraw($);
  void answer(worker, hostOf($), question, given)
    .catch((error: unknown) => `Could not answer #${question.issue}: ${errorText(error)}`)
    .then((text) => {
      view.busy = false;
      view.outcome = text;
      redraw($);
    });
}

function runAction($: EngineInterface, worker: WorkerClient, args: string): void {
  void act(worker, args).then((note) => {
    $.ui.toast(note.text);
    redraw($);
  });
}

async function startSession(
  $: EngineInterface,
  cwd: string,
  isInteractive: boolean,
): Promise<void> {
  await $.command.register({
    name: 'next-issue',
    description:
      'Open the next-issue dashboard of this repository, or a menu to start, stop or refresh its run, or switch its watching or hunting',
  });
  for (const tool of TOOLS) {
    await $.tool.register({ ...tool, inputSchema: { ...tool.inputSchema }, isDeferred: false });
  }
  if (isInteractive) {
    $.clock.every(TICK_MS, () => void tick($, cwd));
  }
}

async function serveTool(
  $: EngineInterface,
  serve: (worker: WorkerClient) => Promise<string>,
): Promise<{ result: string } | { deny: string }> {
  try {
    return { result: await serve(await clientFor($, await $.session.cwd())) };
  } catch (error) {
    return { deny: errorText(error) };
  }
}

function stopPointOf(value: unknown): StopPoint {
  return (STOP_POINTS as readonly unknown[]).includes(value) ? (value as StopPoint) : 'issue';
}

async function runCommand($: EngineInterface): Promise<{ text: string }> {
  let worker: WorkerClient;
  try {
    worker = await clientFor($, await $.session.cwd());
  } catch (error) {
    return { text: `next-issue: ${errorText(error)}` };
  }
  await worker.poll();
  const opened = await $.ui.open({
    id: PANE,
    title: 'next-issue',
    focus: true,
    closeOnEscape: true,
  });
  if (opened.isPlaced) {
    redraw($);
    return { text: 'Opened the next-issue dashboard.' };
  }
  const choices = menuChoices(worker.progress);
  const labels = Object.keys(choices);
  let picked: string;
  try {
    picked = await $.ui.ask(
      'What should next-issue do?',
      labels.length === 1 ? [...labels, 'Cancel'] : labels,
    );
  } catch {
    return { text: await statusOf(worker) };
  }
  let args = choices[picked];
  if (args === undefined) {
    return { text: 'next-issue: nothing done.' };
  }
  if (args === 'stop') {
    const point = await $.ui
      .ask(
        'Stop next-issue when?',
        STOP_CHOICES.map(({ description }) => description),
      )
      .catch(() => undefined);
    const value = STOP_CHOICES.find(({ description }) => description === point)?.value;
    if (value === undefined) {
      return { text: 'next-issue: nothing done.' };
    }
    args = `stop ${value}`;
  }
  return { text: (await act(worker, args)).text };
}

async function renderPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box, Text, Button, Input } = $.ui.resolve(e);
  const worker = await clientFor($, await $.session.cwd()).catch(() => undefined);
  if (worker === undefined) {
    return <Text>Not in a git repository.</Text>;
  }
  const tabs = (
    <Box flexDirection="row" gap={1}>
      {TABS.map((name) => (
        <Button
          key={`tab:${name}`}
          variant={name === view.tab ? 'primary' : 'secondary'}
          onPress={() => show($, worker, name)}
        >
          {name}
        </Button>
      ))}
    </Box>
  );
  const lines = (texts: string[], prefix: string) =>
    texts.map((text, index) => <Text key={`${prefix}:${index}`}>{text === '' ? ' ' : text}</Text>);
  if (view.detail !== undefined) {
    const detail = view.detail;
    return (
      <Box flexDirection="column">
        {tabs}
        <Button key="back" onPress={() => closeDetail($)}>
          Back
        </Button>
        {lines(detail.lines ?? [`Loading #${detail.issue}…`], 'detail')}
      </Box>
    );
  }
  if (view.tab === 'Past') {
    const runs = view.past;
    const chosen = runs?.[view.chosenRun];
    return (
      <Box flexDirection="column">
        {tabs}
        {runs === undefined && <Text>Loading past runs…</Text>}
        {runs !== undefined && runs.length === 0 && <Text>No past runs.</Text>}
        {(runs ?? []).map((item, index) => (
          <Button
            key={`run:${item.id}`}
            variant={index === view.chosenRun ? 'primary' : 'secondary'}
            onPress={() => chooseRun($, index)}
          >
            {runLine(item)}
          </Button>
        ))}
        {chosen !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="bold">Run {runLine(chosen)}</Text>
            {chosen.error !== undefined && <Text color="error">Error: {chosen.error}</Text>}
            <Text>Issues</Text>
            {chosen.issues.length === 0 && <Text> none</Text>}
            {chosen.issues.map((item, index) => (
              <Button
                key={`past:${chosen.id}:${index}`}
                onPress={() => openDetail($, worker, item.issue, chosen.id)}
              >
                {issueNote(item)}
              </Button>
            ))}
            {lines(summaryLines(chosen), 'summary')}
          </Box>
        )}
      </Box>
    );
  }
  if (view.tab === 'Hand-overs') {
    const questions = worker.questions;
    const note = handOverNote(questions, worker.connected);
    const guiding = view.guiding;
    return (
      <Box flexDirection="column">
        {tabs}
        {note !== undefined && <Text>{note}</Text>}
        {note === undefined && <Text weight="bold">Waiting for a person</Text>}
        {(questions ?? []).map((question) => (
          <Box key={`question:${question.issue}`} flexDirection="column" marginTop={1}>
            <Text>
              #{question.issue} {question.title}
            </Text>
            <Text dimColor>{question.reason.replace(/\s+/g, ' ')}</Text>
            <Text dimColor>{question.url}</Text>
            {!view.busy && (
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`retry:${question.issue}`}
                  onPress={() => reply($, worker, question, { kind: 'retry' })}
                >
                  Retry
                </Button>
                <Button key={`guide:${question.issue}`} onPress={() => guide($, question)}>
                  Retry with guidance
                </Button>
                <Button
                  key={`give-up:${question.issue}`}
                  onPress={() => reply($, worker, question, { kind: 'give-up' })}
                >
                  Give up
                </Button>
              </Box>
            )}
            {guiding?.issue === question.issue && (
              <Box flexDirection="column">
                <Input
                  key={`guidance:${question.issue}`}
                  label="Guidance"
                  rows={3}
                  autoFocus
                  submitLabel="post and retry"
                  onSubmit={(text) => submitGuidance($, worker, question, text)}
                />
                {view.problem !== undefined && <Text color="error">{view.problem}</Text>}
              </Box>
            )}
          </Box>
        ))}
        {view.outcome !== undefined && <Text>{view.outcome}</Text>}
      </Box>
    );
  }
  if (view.tab === 'Upcoming') {
    return (
      <Box flexDirection="column">
        {tabs}
        {lines(upcomingLines(view.upcoming), 'upcoming')}
      </Box>
    );
  }
  const progress = worker.progress;
  const now = Date.now();
  return (
    <Box flexDirection="column">
      {tabs}
      {lines(runLines(progress), 'run')}
      {going(progress) && (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Running issues</Text>
          {progress.issues.length === 0 && <Text> none</Text>}
          {progress.issues.map((item) => (
            <Button key={`running:${item.issue}`} onPress={() => openDetail($, worker, item.issue)}>
              {issueLine(item, now)}
            </Button>
          ))}
          <Text weight="bold">Handled issues</Text>
          {progress.handled.length === 0 && <Text> none</Text>}
          {progress.handled.map((item, index) => (
            <Button key={`handled:${index}`} onPress={() => openDetail($, worker, item.issue)}>
              {handledNote(item)}
            </Button>
          ))}
        </Box>
      )}
      <Text weight="bold">Actions</Text>
      <Box flexDirection="column">
        {dashboardActions(progress).map((action) => (
          <Button key={`action:${action.args}`} onPress={() => runAction($, worker, action.args)}>
            {action.label}
          </Button>
        ))}
      </Box>
    </Box>
  );
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await startSession($, e.cwd, e.isInteractive);
    return next(e);
  });
  on('tool.run', { tool: 'mcp__next-issue__next_issue_start' }, ($) => serveTool($, startRun));
  on('tool.run', { tool: 'mcp__next-issue__next_issue_refresh' }, ($) => serveTool($, refreshRun));
  on('tool.run', { tool: 'mcp__next-issue__next_issue_watch' }, ($, e) =>
    serveTool($, (worker) =>
      switchRun(worker, 'watch', (e as unknown as { on?: unknown }).on === true),
    ),
  );
  on('tool.run', { tool: 'mcp__next-issue__next_issue_hunt' }, ($, e) =>
    serveTool($, (worker) =>
      switchRun(worker, 'hunt', (e as unknown as { on?: unknown }).on === true),
    ),
  );
  on('tool.run', { tool: 'mcp__next-issue__next_issue_stop' }, ($, e) =>
    serveTool($, (worker) =>
      stopRun(worker, stopPointOf((e as unknown as { after?: unknown }).after)),
    ),
  );
  on('tool.run', { tool: 'mcp__next-issue__next_issue_status' }, ($) => serveTool($, statusOf));
  on('command.run', { command: 'next-issue' }, ($) => runCommand($));
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e));
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (runText === undefined || e.props.hasSurvey) {
      return next(e);
    }
    const { Text } = $.ui.resolve(e);
    return <Text>{runText}</Text>;
  });
};
