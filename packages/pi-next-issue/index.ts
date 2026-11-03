import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { must, type RunOptions } from './src/exec.ts';
import { repoRoot } from './src/git.ts';
import {
  type Progress,
  type Question,
  spawnWorker,
  WorkerClient,
  type WorkerEvent,
} from './src/worker.ts';

export type Options = {
  client: () => WorkerClient;
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

export function formatQuestions(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'} waiting`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shared(create: () => WorkerClient): WorkerClient {
  const store = globalThis as Record<symbol, WorkerClient | undefined>;
  store[KEY] ??= create();
  return store[KEY];
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function outcomes(progress: Progress): string {
  const done = progress.handled.filter((item) => item.outcome === 'done').length;
  const human = progress.handled.filter((item) => item.outcome === 'needs-human').length;
  const failed = progress.handled.filter((item) => item.outcome === 'error').length;
  const parts = [`${done} done`];
  if (human > 0) {
    parts.push(`${human} needs a human`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  return parts.join(', ');
}

const OUTCOME_NOTES = { done: 'done', 'needs-human': 'needs a human', error: 'failed' } as const;

export function formatStatus(progress: Progress, now: number): string {
  switch (progress.status) {
    case 'running': {
      if (progress.issue === undefined) {
        return 'next-issue · looking for issues';
      }
      const parts = [`next-issue #${progress.issue}`, progress.stage ?? 'prepare'];
      parts.push(`${progress.tools} tools`);
      if (progress.issueStartedAt !== undefined) {
        parts.push(duration(now - progress.issueStartedAt));
      }
      return parts.join(' · ');
    }
    case 'stopping':
      return `next-issue #${progress.issue ?? '?'} · stopping`;
    case 'stopped':
      return `next-issue · stopped: ${outcomes(progress)}`;
    case 'finished':
      return `next-issue · finished: ${outcomes(progress)}`;
    case 'failed':
      return `next-issue · failed: ${progress.error ?? 'unknown error'}`;
  }
}

function packageVersion(): string {
  const raw = readFileSync(join(import.meta.dirname, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

const fromMachine: Options = {
  client: () => {
    const agentDir = getAgentDir();
    return new WorkerClient({
      socketPath: join(agentDir, 'next-issue.sock'),
      version: packageVersion(),
      spawnWorker: (version) => spawnWorker(agentDir, version),
    });
  },
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
      root === undefined ? undefined : shared(options.client).runs[root];

    const render = () => {
      const progress = current();
      if (ui === undefined || progress === undefined) {
        return;
      }
      const dim = (text: string) => (coloured ? ui!.theme.fg('dim', text) : text);
      ui.setStatus(STATUS_KEY, dim(formatStatus(progress, Date.now())));
    };

    const paintQuestions = () => {
      if (ui === undefined || waiting === undefined) {
        return;
      }
      const text = formatQuestions(waiting.length);
      ui.setStatus(
        QUESTIONS_KEY,
        waiting.length === 0 ? undefined : coloured ? ui.theme.fg('dim', text) : text,
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
        shared(options.client).send({ type: 'questions', root });
      }
    };

    const onProgress = (progress: Progress | undefined) => {
      if (progress === undefined) {
        return;
      }
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
      if (progress.status !== status) {
        status = progress.status;
        if (status === 'finished') {
          ui?.notify('next-issue finished', 'info');
        } else if (status === 'stopped') {
          ui?.notify('next-issue stopped', 'info');
        } else if (status === 'failed') {
          ui?.notify(`next-issue failed: ${progress.error ?? 'unknown error'}`, 'error');
        }
      }
      render();
    };

    const onEvent = (event: WorkerEvent) => {
      if (event.type === 'runs' && baseline) {
        baseline = false;
        const progress = root === undefined ? undefined : event.runs[root];
        handled = progress?.handled.length ?? 0;
        status = progress?.status;
        render();
        askQuestions();
      } else if (event.type === 'runs') {
        onProgress(root === undefined ? undefined : event.runs[root]);
      } else if (event.type === 'questions' && event.root === root) {
        onQuestions(event.questions);
      } else if (event.type === 'error' && event.root === root) {
        ui?.notify(`next-issue cannot start: ${event.message}`, 'error');
      }
    };

    const follow = () => {
      unsubscribe?.();
      const progress = current();
      handled = progress?.handled.length ?? 0;
      status = progress?.status;
      waiting =
        root === undefined
          ? undefined
          : shared(options.client).questions[root]?.map((question) => question.issue);
      baseline = !shared(options.client).connected;
      unsubscribe = shared(options.client).subscribe(onEvent);
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
      await shared(options.client).attach();
    });

    pi.on('session_shutdown', async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
      }
      ui = undefined;
    });

    const connect = async (ctx: ExtensionContext) => {
      root = await options.root(ctx.cwd);
      if (ctx.hasUI) {
        show(ctx);
        follow();
      }
      const client = shared(options.client);
      await client.ensure();
      return { client, root, progress: client.runs[root] };
    };

    const going = (progress: Progress | undefined): progress is Progress =>
      progress?.status === 'running' || progress?.status === 'stopping';

    const accepted = (client: WorkerClient, root: string, signal: AbortSignal | undefined) =>
      new Promise<void>((resolve, reject) => {
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
            finish(new Error('the worker closed the connection'));
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

    pi.registerTool({
      name: 'next_issue_start',
      label: 'Start next-issue',
      description:
        'Start a next-issue run of the GitHub issues of this repository when none is going. Starts the worker when needed. When a run is going, starts nothing and reports that run, which picks up new issues by itself.',
      promptSnippet: 'Start a next-issue run of this repository when none is going',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const { client, root, progress } = await connect(ctx);
        if (going(progress)) {
          return {
            content: [
              {
                type: 'text',
                text: `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. It picks up new issues by itself.`,
              },
            ],
            details: { started: false, root },
          };
        }
        const accepting = accepted(client, root, signal);
        client.send({ type: 'start', root, merge: true });
        await accepting;
        return {
          content: [{ type: 'text', text: `Started a next-issue run of ${root}.` }],
          details: { started: true, root },
        };
      },
    });

    const fresh = (client: WorkerClient, root: string) =>
      new Promise<Question[]>((resolve, reject) => {
        const id = randomUUID();
        const stop = client.subscribe((event) => {
          if (event.type === 'questions' && event.root === root && event.id === id) {
            stop();
            resolve(event.questions);
          } else if (event.type === 'questions-error' && event.root === root && event.id === id) {
            stop();
            reject(new Error(event.message));
          } else if (event.type === 'closed') {
            stop();
            reject(new Error('the worker closed the connection'));
          }
        });
        client.send({ type: 'questions', root, id });
      });

    const reply = async (root: string, question: Question, choice: string, guidance: string) => {
      const threads: Array<[string, number]> = [['issue', question.issue]];
      if (question.pr !== undefined) {
        threads.push(['pr', question.pr]);
      }
      const repo = ['--repo', question.repo];
      if (choice === GUIDE) {
        const [kind, number] = threads.at(-1)!;
        await options.gh([kind, 'comment', String(number), ...repo, '--body-file', '-'], {
          cwd: root,
          input: guidance,
        });
      }
      const labels = ['--remove-label', question.labels.needsHuman];
      if (choice === GIVE_UP) {
        labels.push('--add-label', question.labels.skip);
      }
      for (const [kind, number] of threads) {
        await options.gh([kind, 'edit', String(number), ...repo, ...labels], { cwd: root });
      }
    };

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
        const choice = await ctx.ui.select(
          `#${question.issue} ${question.title}\n\n${question.reason || 'No reason given.'}`,
          [RETRY, GUIDE, GIVE_UP],
        );
        if (choice === undefined) {
          return;
        }
        let guidance = '';
        if (choice === GUIDE) {
          guidance = (await ctx.ui.editor(`Guidance for #${question.issue}`))?.trim() ?? '';
          if (guidance === '') {
            return;
          }
        }
        await reply(root, question, choice, guidance);
        ctx.ui.notify(
          `next-issue: #${question.issue} ${choice === GIVE_UP ? 'given up' : 'will be retried'}`,
          'info',
        );
      }
    };

    pi.registerCommand('next-issue', {
      description:
        'Start or stop working through the GitHub issues of this repository, or answer the waiting questions with "answer"',
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
          if (going(progress)) {
            client.send({ type: 'stop', root });
          } else {
            client.send({ type: 'start', root, merge: true });
          }
        } catch (error) {
          ctx.ui.notify(`next-issue cannot start: ${errorText(error)}`, 'error');
        }
      },
    });
  };
}

export default createExtension(fromMachine);
