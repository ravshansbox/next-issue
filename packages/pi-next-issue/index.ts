import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { repoRoot } from './src/git.ts';
import { type Progress, spawnWorker, WorkerClient, type WorkerEvent } from './src/worker.ts';

export type Options = {
  client: () => WorkerClient;
  root: (cwd: string) => Promise<string>;
};

const KEY = Symbol.for('pi-next-issue');
const STATUS_KEY = 'next-issue';

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
    const version = packageVersion();
    return new WorkerClient({
      socketPath: join(agentDir, 'next-issue.sock'),
      version,
      spawnWorker: () => spawnWorker(agentDir, version),
    });
  },
  root: repoRoot,
};

export function createExtension(options: Options) {
  return (pi: ExtensionAPI) => {
    let ui: ExtensionContext['ui'] | undefined;
    let coloured = false;
    let root: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
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
      } else if (event.type === 'runs') {
        onProgress(root === undefined ? undefined : event.runs[root]);
      } else if (event.root === root) {
        ui?.notify(`next-issue cannot start: ${event.message}`, 'error');
      }
    };

    const follow = () => {
      unsubscribe?.();
      const progress = current();
      handled = progress?.handled.length ?? 0;
      status = progress?.status;
      baseline = !shared(options.client).connected;
      unsubscribe = shared(options.client).subscribe(onEvent);
      render();
    };

    const show = (ctx: ExtensionContext) => {
      ui = ctx.ui;
      coloured = ctx.mode === 'tui';
      timer ??= setInterval(render, 1000);
      timer.unref?.();
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
      ui = undefined;
    });

    pi.registerCommand('next-issue', {
      description: 'Start or stop working through the GitHub issues of this repository',
      handler: async (_args, ctx) => {
        try {
          root = await options.root(ctx.cwd);
          if (ctx.hasUI) {
            show(ctx);
            follow();
          }
          const client = shared(options.client);
          await client.ensure();
          const progress = client.runs[root];
          if (progress?.status === 'running' || progress?.status === 'stopping') {
            client.send({ type: 'stop', root });
          } else {
            client.send({ type: 'start', root, merge: true });
          }
        } catch (error) {
          ctx.ui.notify(
            `next-issue cannot start: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
      },
    });
  };
}

export default createExtension(fromMachine);
