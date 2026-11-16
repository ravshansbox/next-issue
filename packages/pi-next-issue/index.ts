import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { shared } from './src/clients.ts';
import { errorText } from './src/errors.ts';
import { repoRoot } from './src/git.ts';
import { going, type Progress, type Question, STOP_POINTS } from './src/protocol.ts';
import {
  huntRun,
  parseStartArgs,
  parseStopArgs,
  parseSwitchArgs,
  requestStart,
  requestStop,
  requestSwitch,
  refreshRun,
  startRun,
  statusOf,
  stopRun,
  watchRun,
} from './src/run.ts';
import {
  type Action,
  cannotNote,
  formatQuestions,
  formatStatus,
  handledNotes,
  type Note,
  questionNotes,
  statusNote,
  switchNote,
} from './src/status.ts';
import { lockHolder } from './src/lock.ts';
import { spawnWorker, workerPaths } from './src/spawn-worker.ts';
import { WorkerClient, type WorkerEvent } from './src/worker.ts';

export type Options = {
  client: (root: string) => WorkerClient;
  root: (cwd: string) => Promise<string>;
};

const STATUS_KEY = 'next-issue';
const QUESTIONS_KEY = 'next-issue-questions';
const RENDER_MS = 1000;
const QUESTIONS_MS = 60_000;
const SUBCOMMANDS: Action[] = ['start', 'stop', 'watch', 'hunt'];
const VALUES: Partial<Record<Action, Array<{ value: string; description: string }>>> = {
  stop: [
    { value: 'issue', description: 'Stop after the running issues' },
    { value: 'round', description: 'Stop after the current round of each running issue' },
    { value: 'now', description: 'Stop at once' },
  ],
  watch: [
    { value: 'on', description: 'Keep watching for new issues after the current pass' },
    { value: 'off', description: 'End the going run after the current pass, with hunting off' },
  ],
  hunt: [
    { value: 'on', description: 'Hunt for bugs in the going run' },
    {
      value: 'off',
      description: 'Start no new hunt in the going run, and let a going hunt finish',
    },
  ],
};
const USAGE = [
  '/next-issue start           start a run of this repository: one pass, with watching and hunting off',
  '/next-issue stop [issue|round|now]',
  '                            stop the run of this repository after the running issues (issue, the default), after the current round (round), or at once (now)',
  '/next-issue watch on|off    keep the going run of this repository watching for new issues after the current pass, or end it after the current pass with hunting off, with no restart',
  '/next-issue hunt on|off     switch hunting of the going run of this repository on (which turns watching on too) or off, with no restart',
].join('\n');

function completions(prefix: string) {
  if (!prefix.includes(' ')) {
    return SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
      value: name,
      label: name,
    }));
  }
  const [subcommand = '', partial = '', ...rest] = prefix.split(' ');
  if (rest.length > 0) {
    return [];
  }
  return (VALUES[subcommand as Action] ?? [])
    .filter(({ value }) => value.startsWith(partial))
    .map(({ value, description }) => ({
      value: `${subcommand} ${value}`,
      label: value,
      description,
    }));
}

function background(callback: () => void, ms: number): ReturnType<typeof setInterval> {
  const timer = setInterval(callback, ms);
  timer.unref?.();
  return timer;
}

function packageVersion(): string {
  const raw = readFileSync(join(import.meta.dirname, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

const fromMachine: Options = {
  client: (root) =>
    new WorkerClient({
      socketPath: workerPaths(root).socketPath,
      version: packageVersion(),
      spawnWorker: (version, onExit) => spawnWorker(root, version, onExit),
      lockHolder: () => lockHolder(workerPaths(root).lockPath),
    }),
  root: repoRoot,
};

export function createExtension(options: Options) {
  return (pi: ExtensionAPI) => {
    let ui: ExtensionContext['ui'] | undefined;
    let coloured = false;
    let root: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let waiting: number[] | undefined;
    let unsubscribe: (() => void) | undefined;
    let handled = 0;
    let status: Progress['status'] | undefined;
    let hunting: boolean | undefined;
    let watching: boolean | undefined;
    let baseline = false;
    // The worker answers a refused request with an error that does not name it.
    // A refresh is best effort, so an error that answers it is not shown.
    let asked: Action | 'refresh' = 'start';

    const clientOf = (root: string) => shared(options.client, root);

    const current = (): Progress | undefined =>
      root === undefined ? undefined : clientOf(root).runs[root];

    const remember = (progress: Progress | undefined) => {
      handled = progress?.handled.length ?? 0;
      status = progress?.status;
      hunting = progress?.hunting;
      watching = progress?.watching;
    };

    const dim = (text: string) => (coloured && ui !== undefined ? ui.theme.fg('dim', text) : text);

    const render = () => {
      const progress = current();
      if (ui === undefined || progress === undefined) {
        return;
      }
      const ended = progress.status === 'finished' || progress.status === 'stopped';
      ui.setStatus(STATUS_KEY, ended ? undefined : dim(formatStatus(progress, Date.now())));
    };

    const paintQuestions = () => {
      if (ui === undefined || waiting === undefined) {
        return;
      }
      ui.setStatus(
        QUESTIONS_KEY,
        waiting.length === 0 ? undefined : dim(formatQuestions(waiting.length)),
      );
    };

    const tell = (note: Note | undefined) => {
      if (note !== undefined) {
        ui?.notify(note.text, note.level);
      }
    };

    const onQuestions = (questions: Question[]) => {
      const known = waiting;
      waiting = questions.map((question) => question.issue);
      questionNotes(questions, known).forEach(tell);
      paintQuestions();
    };

    const askQuestions = () => {
      if (root !== undefined) {
        clientOf(root).send({ type: 'questions', root });
      }
    };

    const announce = (progress: Progress) => {
      const wasGoing = status === 'running' || status === 'stopping';
      const changed = (was: boolean | undefined, now: boolean | undefined): now is boolean =>
        wasGoing && going(progress) && was !== undefined && now !== undefined && now !== was;
      if (changed(watching, progress.watching)) {
        tell(switchNote('watching', progress.watching));
      }
      if (changed(hunting, progress.hunting)) {
        tell(switchNote('hunting', progress.hunting));
      }
      watching = progress.watching;
      hunting = progress.hunting;
      if (progress.status === status) {
        return;
      }
      status = progress.status;
      tell(statusNote(progress));
    };

    const notifyHandled = (progress: Progress) => {
      if (progress.handled.length < handled) {
        handled = 0;
      }
      handledNotes(progress, handled).forEach(tell);
      handled = progress.handled.length;
    };

    const onProgress = (progress: Progress | undefined) => {
      if (progress === undefined) {
        return;
      }
      notifyHandled(progress);
      announce(progress);
      render();
    };

    const onEvent = (event: WorkerEvent) => {
      if (event.type === 'runs') {
        const progress = root === undefined ? undefined : event.runs[root];
        if (baseline) {
          baseline = false;
          remember(progress);
          render();
          askQuestions();
        } else {
          onProgress(progress);
        }
      } else if (event.type === 'questions' && event.root === root) {
        onQuestions(event.questions);
      } else if (event.type === 'error' && event.root === root && asked !== 'refresh') {
        tell(cannotNote(asked, event.message));
      } else if (event.type === 'closed') {
        baseline = true;
        waiting = undefined;
        ui?.setStatus(STATUS_KEY, undefined);
        ui?.setStatus(QUESTIONS_KEY, undefined);
      }
    };

    const follow = () => {
      unsubscribe?.();
      if (root === undefined) {
        return;
      }
      const client = clientOf(root);
      remember(current());
      waiting = client.questions[root]?.map((question) => question.issue);
      baseline = !client.connected;
      unsubscribe = client.subscribe(onEvent);
      render();
      paintQuestions();
      if (!baseline) {
        askQuestions();
      }
    };

    const show = (ctx: ExtensionContext) => {
      ui = ctx.ui;
      coloured = ctx.mode === 'tui';
      timer ??= background(render, RENDER_MS);
      poll ??= background(askQuestions, QUESTIONS_MS);
    };

    pi.on('session_start', async (_event, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      show(ctx);
      root = await options.root(ctx.cwd).catch(() => undefined);
      if (root === undefined) {
        return;
      }
      follow();
      await clientOf(root).attach();
    });

    pi.on('session_shutdown', async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      clearInterval(timer);
      timer = undefined;
      clearInterval(poll);
      poll = undefined;
      ui = undefined;
    });

    const connect = async (ctx: ExtensionContext, startWorker = true) => {
      root = await options.root(ctx.cwd);
      if (ctx.hasUI) {
        show(ctx);
        follow();
      }
      const client = clientOf(root);
      await (startWorker ? client.ensure() : client.reach());
      return { client, root, progress: client.runs[root] };
    };

    pi.registerTool({
      name: 'next_issue_start',
      label: 'Start next-issue',
      description:
        'Start a next-issue run of the GitHub issues of this repository when none is going: one pass, with watching and hunting off (next_issue_watch and next_issue_hunt switch them). Starts the worker when needed. When a run is going, starts nothing, asks that run to check for new issues now and reports that run.',
      promptSnippet: 'Start a next-issue run of this repository when none is going',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx);
        asked = 'start';
        return startRun(client, root, progress, signal, () => {
          asked = 'refresh';
        });
      },
    });

    pi.registerTool({
      name: 'next_issue_refresh',
      label: 'Refresh next-issue',
      description:
        'Ask the going next-issue run of this repository to check for new issues now (call it after filing an issue). Never starts a worker or a run: when no run is going, it says so.',
      promptSnippet: 'Ask the going next-issue run of this repository to check for new issues now',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const root = await options.root(ctx.cwd);
        return refreshRun(clientOf(root), root, () => {
          asked = 'refresh';
        });
      },
    });

    pi.registerTool({
      name: 'next_issue_watch',
      label: 'Switch next-issue watching',
      description:
        'Switch watching for new issues on or off for the going next-issue run of this repository, with no restart: the run keeps its issues. On keeps the run going after the current pass, and it reads the open issues again after each pass. Off ends the run after the current pass, and turns hunting off too. Fails when no run is going.',
      promptSnippet: 'Switch watching of the going next-issue run on or off',
      parameters: Type.Object({
        on: Type.Boolean({ description: 'true to keep watching, false to end after this pass' }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx, false);
        asked = 'watch';
        return watchRun(client, root, progress, params.on, signal);
      },
    });

    pi.registerTool({
      name: 'next_issue_hunt',
      label: 'Switch next-issue hunting',
      description:
        'Switch hunting for bugs on or off for the going next-issue run of this repository, with no restart: the run keeps its issues. On also turns watching on. Off lets a hunt that is going finish and starts no new one. Fails when no run is going.',
      promptSnippet: 'Switch hunting of the going next-issue run on or off',
      parameters: Type.Object({
        on: Type.Boolean({ description: 'true to hunt, false to stop hunting' }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx, false);
        asked = 'hunt';
        return huntRun(client, root, progress, params.on, signal);
      },
    });

    pi.registerTool({
      name: 'next_issue_stop',
      label: 'Stop next-issue',
      description:
        'Ask the going next-issue run of this repository to stop: after the running issues (issue, the default), after the current round (round), or at once (now). Returns at once, without waiting for the run to end. Fails when no run is going.',
      promptSnippet: 'Stop the going next-issue run of this repository',
      parameters: Type.Object({
        after: Type.Optional(
          Type.Union(
            STOP_POINTS.map((point) => Type.Literal(point)),
            { description: 'When to stop: issue (the default), round or now' },
          ),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx, false);
        return stopRun(client, root, progress, params.after ?? 'issue');
      },
    });

    pi.registerTool({
      name: 'next_issue_status',
      label: 'next-issue status',
      description:
        'Report the next-issue run of this repository: its status line, then each handled issue with its outcome. Never starts a worker.',
      promptSnippet: 'Report the next-issue run of this repository',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const root = await options.root(ctx.cwd);
        return statusOf(clientOf(root), root);
      },
    });

    pi.registerCommand('next-issue', {
      description:
        '"start" starts working through the GitHub issues of this repository, one pass. "stop [issue|round|now]" stops the run after the running issues (the default), after the current round, or at once. "watch on|off" keeps the going run watching for new issues, or ends it after the current pass. "hunt on|off" switches hunting of the going run',
      getArgumentCompletions: (prefix) => {
        const matches = completions(prefix);
        return matches.length === 0 ? null : matches;
      },
      handler: async (args, ctx) => {
        const [subcommand, ...values] = args.trim().split(/\s+/).filter(Boolean);
        if (subcommand === undefined || !SUBCOMMANDS.includes(subcommand as Action)) {
          ctx.ui.notify(USAGE, 'info');
          return;
        }
        const notify = (note: Note | undefined) => {
          if (note !== undefined) {
            ctx.ui.notify(note.text, note.level);
          }
        };
        try {
          if (subcommand === 'start') {
            parseStartArgs(values);
          }
          const after = subcommand === 'stop' ? parseStopArgs(values) : undefined;
          const toggled = subcommand === 'watch' || subcommand === 'hunt' ? subcommand : undefined;
          const on = toggled === undefined ? undefined : parseSwitchArgs(toggled, values);
          const { client, root, progress } = await connect(ctx, subcommand === 'start');
          if (after !== undefined) {
            notify(requestStop(client, root, progress, after));
          } else if (toggled !== undefined && on !== undefined) {
            asked = toggled;
            notify(requestSwitch(client, root, progress, toggled, on));
          } else {
            asked = 'start';
            notify(
              requestStart(client, root, progress, () => {
                asked = 'refresh';
              }),
            );
          }
        } catch (error) {
          notify(cannotNote(subcommand as Action, errorText(error)));
        }
      },
    });
  };
}

export default createExtension(fromMachine);
