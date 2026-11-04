import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { errorText, must, type RunOptions } from './src/exec.ts';
import { repoRoot } from './src/git.ts';
import { going, type Progress, type Question } from './src/protocol.ts';
import { spawnWorker, WorkerClient, type WorkerEvent, workerPaths } from './src/worker.ts';

export type Options = {
  client: (root: string) => WorkerClient;
  root: (cwd: string) => Promise<string>;
  gh: (args: string[], options: RunOptions) => Promise<string>;
};

const KEY = Symbol.for('pi-next-issue');
const STATUS_KEY = 'next-issue';
const QUESTIONS_KEY = 'next-issue-questions';
const QUESTIONS_MS = 60_000;
const RETRY = 'Retry';
const GUIDE = 'Retry with guidance';
const GIVE_UP = 'Give up';
const CLOSED = 'the worker closed the connection';

function formatQuestions(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'} waiting`;
}

function threadsOf(question: Question): Array<[string, number]> {
  return question.pr === undefined
    ? [['issue', question.issue]]
    : [
        ['issue', question.issue],
        ['pr', question.pr],
      ];
}

function promptOf(question: Question): string {
  return `#${question.issue} ${question.title}\n\n${question.reason || 'No reason given.'}`;
}

function answeredOf(question: Question, choice: string): string {
  return `next-issue: #${question.issue} ${choice === GIVE_UP ? 'given up' : 'will be retried'}`;
}

function labelsOf(question: Question, choice: string): string[] {
  const remove = ['--remove-label', question.labels.needsHuman];
  return choice === GIVE_UP ? [...remove, '--add-label', question.labels.skip] : remove;
}

function shared(create: (root: string) => WorkerClient, root: string): WorkerClient {
  const store = globalThis as Record<symbol, Map<string, WorkerClient> | undefined>;
  const clients = (store[KEY] ??= new Map());
  let client = clients.get(root);
  if (client === undefined) {
    client = create(root);
    clients.set(root, client);
  }
  return client;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

const OUTCOME_NOTES = { done: 'done', 'needs-human': 'needs a human', error: 'failed' } as const;

type Outcome = keyof typeof OUTCOME_NOTES;

function outcomes(progress: Progress): string {
  const count = (outcome: Outcome): number =>
    progress.handled.filter((item) => item.outcome === outcome).length;
  return (Object.keys(OUTCOME_NOTES) as Outcome[])
    .filter((outcome) => outcome === 'done' || count(outcome) > 0)
    .map((outcome) => `${count(outcome)} ${OUTCOME_NOTES[outcome]}`)
    .join(', ');
}

export function formatStatus(progress: Progress, now: number): string {
  const running = progress.issues ?? [];
  switch (progress.status) {
    case 'running': {
      if (running.length === 0) {
        return 'looking for issues';
      }
      const count = progress.open === undefined ? '' : `/${progress.open}`;
      const lines = running.map((item) => {
        const parts = [`#${item.issue}${count}`, item.stage ?? 'prepare', `${item.tools} tools`];
        if (item.startedAt !== undefined) {
          parts.push(duration(now - item.startedAt));
        }
        return parts.join(' · ');
      });
      return lines.join(' | ');
    }
    case 'stopping': {
      const issues = running.map((item) => `#${item.issue}`);
      return `${issues.length === 0 ? '#?' : issues.join(' ')} · stopping`;
    }
    case 'stopped':
    case 'finished':
      return `${progress.status}: ${outcomes(progress)}`;
    case 'failed':
      return `failed: ${progress.error ?? 'unknown error'}`;
  }
}

function report(text: string, root: string) {
  return { content: [{ type: 'text' as const, text }], details: { root } };
}

function startReport(text: string, root: string, started: boolean) {
  return { ...report(text, root), details: { started, root } };
}

function packageVersion(): string {
  const raw = readFileSync(join(import.meta.dirname, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function accepted(
  client: WorkerClient,
  root: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      stop();
      signal?.removeEventListener('abort', abort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const abort = () => finish(new Error('next_issue_start was cancelled'));
    const stop = client.subscribe((event) => {
      if (event.type === 'error' && event.root === root) {
        finish(new Error(event.message));
      } else if (event.type === 'closed') {
        finish(new Error(CLOSED));
      } else if (event.type === 'runs' && going(event.runs[root])) {
        finish();
      }
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

function fresh(client: WorkerClient, root: string): Promise<Question[]> {
  return new Promise<Question[]>((resolve, reject) => {
    const id = randomUUID();
    const stop = client.subscribe((event) => {
      if (event.type === 'closed') {
        stop();
        reject(new Error(CLOSED));
      } else if (
        (event.type === 'questions' || event.type === 'questions-error') &&
        event.root === root &&
        event.id === id
      ) {
        stop();
        if (event.type === 'questions') {
          resolve(event.questions);
        } else {
          reject(new Error(event.message));
        }
      }
    });
    client.send({ type: 'questions', root, id });
  });
}

async function reply(
  gh: Options['gh'],
  root: string,
  question: Question,
  choice: string,
  guidance: string,
): Promise<void> {
  const threads = threadsOf(question);
  const repo = ['--repo', question.repo];
  if (choice === GUIDE) {
    const [kind, number] = threads.at(-1)!;
    await gh([kind, 'comment', String(number), ...repo, '--body-file', '-'], {
      cwd: root,
      input: guidance,
    });
  }
  const labels = labelsOf(question, choice);
  for (const [kind, number] of threads) {
    await gh([kind, 'edit', String(number), ...repo, ...labels], { cwd: root });
  }
}

async function ask(
  ui: ExtensionContext['ui'],
  question: Question,
): Promise<{ choice: string; guidance: string } | undefined> {
  const choice = await ui.select(promptOf(question), [RETRY, GUIDE, GIVE_UP]);
  if (choice === undefined) {
    return undefined;
  }
  if (choice !== GUIDE) {
    return { choice, guidance: '' };
  }
  const guidance = (await ui.editor(`Guidance for #${question.issue}`))?.trim() ?? '';
  return guidance === '' ? undefined : { choice, guidance };
}

async function statusOf(client: WorkerClient, root: string) {
  await client.attach();
  if (!client.connected) {
    return report('no worker is running', root);
  }
  const progress = client.runs[root];
  if (progress === undefined) {
    return report(`no run of ${root}`, root);
  }
  const lines = [
    formatStatus(progress, Date.now()),
    ...progress.handled.map((item) => `#${item.issue} ${OUTCOME_NOTES[item.outcome]}`),
  ];
  return report(lines.join('\n'), root);
}

function sendStart(client: WorkerClient, root: string): void {
  client.send({ type: 'start', root, merge: true });
}

async function startRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  signal: AbortSignal | undefined,
) {
  if (going(progress)) {
    return startReport(
      `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. It picks up new issues by itself.`,
      root,
      false,
    );
  }
  const accepting = accepted(client, root, signal);
  sendStart(client, root);
  await accepting;
  return startReport(`Started a next-issue run of ${root}.`, root, true);
}

function toggle(client: WorkerClient, root: string, progress: Progress | undefined): void {
  if (going(progress)) {
    client.send({ type: 'stop', root });
  } else {
    sendStart(client, root);
  }
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

    const current = (): Progress | undefined =>
      root === undefined ? undefined : shared(options.client, root).runs[root];

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

    const onQuestions = (questions: Question[]) => {
      const known = waiting;
      waiting = questions.map((question) => question.issue);
      for (const question of questions) {
        if (known !== undefined && !known.includes(question.issue)) {
          ui?.notify(`next-issue: #${question.issue} has a question: ${question.title}`, 'warning');
        }
      }
      paintQuestions();
    };

    const askQuestions = () => {
      if (root !== undefined) {
        shared(options.client, root).send({ type: 'questions', root });
      }
    };

    const announce = (progress: Progress) => {
      if (progress.status === status) {
        return;
      }
      status = progress.status;
      if (status === 'finished' || status === 'stopped') {
        ui?.notify(`next-issue ${status}`, 'info');
      } else if (status === 'failed') {
        ui?.notify(`next-issue failed: ${progress.error ?? 'unknown error'}`, 'error');
      }
    };

    const notifyHandled = (progress: Progress) => {
      if (progress.handled.length < handled) {
        handled = 0;
      }
      for (const item of progress.handled.slice(handled)) {
        ui?.notify(
          `next-issue: #${item.issue} ${OUTCOME_NOTES[item.outcome]}`,
          item.outcome === 'done' ? 'info' : 'warning',
        );
      }
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
        ui?.notify(`next-issue cannot start: ${event.message}`, 'error');
      }
    };

    const follow = () => {
      unsubscribe?.();
      if (root === undefined) {
        return;
      }
      const client = shared(options.client, root);
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
      await shared(options.client, root).attach();
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
      const client = shared(options.client, root);
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
        return statusOf(shared(options.client, root), root);
      },
    });

    const answer = async (ctx: ExtensionContext) => {
      const { client, root } = await connect(ctx);
      const passed = new Set<number>();
      for (;;) {
        const question = (await fresh(client, root)).find((item) => !passed.has(item.issue));
        if (question === undefined) {
          if (passed.size === 0) {
            ctx.ui.notify('next-issue: no questions waiting', 'info');
          }
          return;
        }
        passed.add(question.issue);
        const picked = await ask(ctx.ui, question);
        if (picked === undefined) {
          return;
        }
        const { choice, guidance } = picked;
        await reply(options.gh, root, question, choice, guidance);
        ctx.ui.notify(answeredOf(question, choice), 'info');
      }
    };

    pi.registerCommand('next-issue', {
      description:
        'Start or stop working through the GitHub issues of this repository, or answer the waiting questions with "answer"',
      getArgumentCompletions: (prefix) =>
        'answer'.startsWith(prefix) ? [{ value: 'answer', label: 'answer' }] : null,
      handler: async (args, ctx) => {
        if (args.trim() === 'answer') {
          try {
            await answer(ctx);
          } catch (error) {
            ctx.ui.notify(`next-issue cannot answer: ${errorText(error)}`, 'error');
          }
          return;
        }
        try {
          const { client, root, progress } = await connect(ctx);
          toggle(client, root, progress);
        } catch (error) {
          ctx.ui.notify(`next-issue cannot start: ${errorText(error)}`, 'error');
        }
      },
    });
  };
}

export default createExtension(fromMachine);
