import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { answerAll, type Gh } from './src/answer.ts';
import { shared } from './src/clients.ts';
import { errorText, must } from './src/exec.ts';
import { repoRoot } from './src/git.ts';
import type { Progress, Question } from './src/protocol.ts';
import { startRun, statusOf, toggle } from './src/run.ts';
import {
  cannotNote,
  formatQuestions,
  formatStatus,
  handledNotes,
  type Note,
  questionNotes,
  statusNote,
} from './src/status.ts';
import { spawnWorker, WorkerClient, type WorkerEvent, workerPaths } from './src/worker.ts';

export type Options = {
  client: (root: string) => WorkerClient;
  root: (cwd: string) => Promise<string>;
  gh: Gh;
};

const STATUS_KEY = 'next-issue';
const QUESTIONS_KEY = 'next-issue-questions';
const QUESTIONS_MS = 60_000;

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
      timer ??= setInterval(render, 1000);
      timer.unref?.();
      poll ??= setInterval(askQuestions, QUESTIONS_MS);
      poll.unref?.();
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
      description:
        'Start a next-issue run of the GitHub issues of this repository when none is going. Starts the worker when needed. When a run is going, starts nothing and reports that run, which picks up new issues by itself.',
      promptSnippet: 'Start a next-issue run of this repository when none is going',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx);
        return startRun(client, root, progress, signal);
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
        'Start or stop working through the GitHub issues of this repository, or answer the waiting questions with "answer"',
      getArgumentCompletions: (prefix) =>
        'answer'.startsWith(prefix) ? [{ value: 'answer', label: 'answer' }] : null,
      handler: async (args, ctx) => {
        const answering = args.trim() === 'answer';
        try {
          const { client, root, progress } = await connect(ctx);
          if (answering) {
            await answerAll(ctx.ui, options.gh, client, root);
          } else {
            toggle(client, root, progress);
          }
        } catch (error) {
          const note = cannotNote(answering ? 'answer' : 'start', errorText(error));
          ctx.ui.notify(note.text, note.level);
        }
      },
    });
  };
}

export default createExtension(fromMachine);
