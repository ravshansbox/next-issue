import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { answerAll, type Gh } from './src/answer.ts';
import { shared } from './src/clients.ts';
import { errorText } from './src/errors.ts';
import { must } from './src/exec.ts';
import { repoRoot } from './src/git.ts';
import type { Progress, Question } from './src/protocol.ts';
import { parseStopArgs, requestStart, requestStop, startRun, statusOf } from './src/run.ts';
import {
  type Action,
  cannotNote,
  formatQuestions,
  formatStatus,
  handledNotes,
  type Note,
  questionNotes,
  statusNote,
} from './src/status.ts';
import { spawnWorker, workerPaths } from './src/spawn-worker.ts';
import { WorkerClient, type WorkerEvent } from './src/worker.ts';

export type Options = {
  client: (root: string) => WorkerClient;
  root: (cwd: string) => Promise<string>;
  gh: Gh;
};

const STATUS_KEY = 'next-issue';
const QUESTIONS_KEY = 'next-issue-questions';
const RENDER_MS = 1000;
const QUESTIONS_MS = 60_000;
const SUBCOMMANDS: Action[] = ['start', 'stop', 'answer'];
const START_FLAGS = [
  { flag: '--once', insert: '--once', description: 'Stop after the first handled issue' },
  { flag: '--max', insert: '--max ', argument: '<n>', description: 'Handle at most n issues' },
  {
    flag: '--watch',
    insert: '--watch',
    description: 'Keep running, and read the open issues again after each pass',
  },
  {
    flag: '--hunt',
    insert: '--hunt',
    description: 'Hunt the repository for bugs alongside the issues',
  },
  {
    flag: '--reset',
    insert: '--reset',
    description: 'Drop the saved budgets and findings, and keep the rest of the state',
  },
  {
    flag: '--verbose',
    insert: '--verbose',
    description: 'Show every command and all agent output',
  },
  { flag: '--quiet', insert: '--quiet', description: 'Show only the milestones and the summary' },
];
const FLAGS = START_FLAGS.map(({ flag, argument }) =>
  argument ? `${flag} ${argument}` : flag,
).join(', ');
const USAGE = [
  '/next-issue start [flags]  start a run of this repository, with flags from: ' + FLAGS,
  '/next-issue stop [--after issue|round|now]',
  '                           stop the run of this repository after the running issues (issue, the default), after the current round (round), or at once (now)',
  '/next-issue answer         answer the waiting questions',
].join('\n');

function completions(prefix: string) {
  if (!prefix.includes(' ')) {
    return SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
      value: name,
      label: name,
    }));
  }
  if (!prefix.startsWith('start ')) {
    return [];
  }
  const head = prefix.slice(0, prefix.lastIndexOf(' ') + 1);
  const partial = prefix.slice(head.length);
  const typed = head.split(/\s+/);
  return START_FLAGS.filter(({ flag }) => flag.startsWith(partial) && !typed.includes(flag)).map(
    ({ flag, insert, description }) => ({ value: head + insert, label: flag, description }),
  );
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
      spawnWorker: (version) => spawnWorker(root, version),
    }),
  root: repoRoot,
  gh: (args, options) => must('gh', args, options),
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
    let baseline = false;

    const clientOf = (root: string) => shared(options.client, root);

    const current = (): Progress | undefined =>
      root === undefined ? undefined : clientOf(root).runs[root];

    const remember = (progress: Progress | undefined) => {
      handled = progress?.handled.length ?? 0;
      status = progress?.status;
    };

    const dim = (text: string) => (coloured && ui !== undefined ? ui.theme.fg('dim', text) : text);

    const render = () => {
      const progress = current();
      if (ui === undefined || progress === undefined) {
        return;
      }
      ui.setStatus(STATUS_KEY, dim(formatStatus(progress, Date.now())));
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
      } else if (event.type === 'error' && event.root === root) {
        tell(cannotNote('start', event.message));
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

    const connect = async (ctx: ExtensionContext) => {
      root = await options.root(ctx.cwd);
      if (ctx.hasUI) {
        show(ctx);
        follow();
      }
      const client = clientOf(root);
      await client.ensure();
      return { client, root, progress: client.runs[root] };
    };

    pi.registerTool({
      name: 'next_issue_start',
      label: 'Start next-issue',
      description: `Start a next-issue run of the GitHub issues of this repository when none is going. Starts the worker when needed. When a run is going, starts nothing and reports that run, which picks up new issues by itself. Optional args take the flags ${FLAGS}, for example ["--hunt"] to hunt for bugs and keep watching.`,
      promptSnippet: 'Start a next-issue run of this repository when none is going',
      parameters: Type.Object({
        args: Type.Optional(
          Type.Array(Type.String(), {
            description: `Flags for the run, from: ${FLAGS}`,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx);
        return startRun(client, root, progress, params.args ?? [], signal);
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
      description: `"start [flags]" starts working through the GitHub issues of this repository, with flags from ${FLAGS}. "stop [--after issue|round|now]" stops the run after the running issues (the default), after the current round, or at once. "answer" answers the waiting questions`,
      getArgumentCompletions: (prefix) => {
        const matches = completions(prefix);
        return matches.length === 0 ? null : matches;
      },
      handler: async (args, ctx) => {
        const [subcommand, ...flags] = args.trim().split(/\s+/).filter(Boolean);
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
          const after = subcommand === 'stop' ? parseStopArgs(flags) : undefined;
          const { client, root, progress } = await connect(ctx);
          if (subcommand === 'answer') {
            await answerAll(ctx.ui, options.gh, client, root);
          } else if (after !== undefined) {
            notify(requestStop(client, root, progress, after));
          } else {
            notify(requestStart(client, root, progress, flags));
          }
        } catch (error) {
          notify(cannotNote(subcommand as Action, errorText(error)));
        }
      },
    });
  };
}

export default createExtension(fromMachine);
