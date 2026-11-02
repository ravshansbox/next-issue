import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './src/config.ts';
import { repoRoot } from './src/git.ts';
import { createPorts } from './src/ports.ts';
import { type Progress, Runner } from './src/runner.ts';

type Launch = (cwd: string) => Promise<Runner>;

type Holder = { runner?: Runner; launching?: boolean };

const KEY = Symbol.for('pi-next-issue');
const STATUS_KEY = 'next-issue';

function holder(): Holder {
  const store = globalThis as Record<symbol, Holder | undefined>;
  store[KEY] ??= {};
  return store[KEY];
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function outcomes(progress: Progress): string {
  const merged = progress.handled.filter((item) => item.outcome === 'merged').length;
  const human = progress.handled.length - merged;
  const parts = [`${merged} merged`];
  if (human > 0) {
    parts.push(`${human} needs a human`);
  }
  return parts.join(', ');
}

export function formatStatus(progress: Progress, now: number): string {
  switch (progress.status) {
    case 'idle':
      return 'next-issue · starting';
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

const launchFromRepo: Launch = async (cwd) => {
  const root = await repoRoot(cwd);
  const config = await loadConfig(root);
  return new Runner(await createPorts(root, config), config);
};

export function createExtension(launch: Launch) {
  return (pi: ExtensionAPI) => {
    let ui: ExtensionContext['ui'] | undefined;
    let coloured = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let handled = 0;
    let status: Progress['status'] | undefined;

    const render = () => {
      const runner = holder().runner;
      if (ui === undefined || runner === undefined) {
        return;
      }
      const progress = runner.progress;
      const theme = ui.theme;
      const dim = (text: string) => (coloured ? theme.fg('dim', text) : text);
      ui.setStatus(STATUS_KEY, dim(formatStatus(progress, Date.now())));
      const active = progress.status === 'running' && progress.lastTool !== undefined;
      ui.setWidget(STATUS_KEY, active ? [dim(`↳ ${progress.lastTool}`)] : undefined);
    };

    const onChange = (progress: Progress) => {
      for (const item of progress.handled.slice(handled)) {
        ui?.notify(
          `next-issue: #${item.issue} ${item.outcome === 'merged' ? 'merged' : 'needs a human'}`,
          item.outcome === 'merged' ? 'info' : 'warning',
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

    const follow = (runner: Runner) => {
      unsubscribe?.();
      handled = runner.progress.handled.length;
      status = runner.progress.status;
      unsubscribe = runner.subscribe(onChange);
      render();
    };

    const detach = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      ui = undefined;
    };

    pi.on('session_start', async (_event, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      ui = ctx.ui;
      coloured = ctx.mode === 'tui';
      timer ??= setInterval(render, 1000);
      timer.unref?.();
      const runner = holder().runner;
      if (runner !== undefined) {
        follow(runner);
      }
    });

    pi.on('session_shutdown', async (event) => {
      detach();
      if (event.reason === 'quit') {
        holder().runner?.stop();
      }
    });

    pi.registerCommand('next-issue', {
      description: 'Start or stop working through the GitHub issues of this repository',
      handler: async (_args, ctx) => {
        const current = holder().runner;
        const busy =
          current?.progress.status === 'running' || current?.progress.status === 'stopping';
        if (busy) {
          current?.stop();
          return;
        }
        if (holder().launching) {
          ctx.ui.notify('next-issue is starting already', 'warning');
          return;
        }
        holder().launching = true;
        let runner: Runner;
        try {
          runner = await launch(ctx.cwd);
        } catch (error) {
          ctx.ui.notify(
            `next-issue cannot start: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
          return;
        } finally {
          holder().launching = false;
        }
        holder().runner = runner;
        if (ctx.hasUI) {
          ui = ctx.ui;
          coloured = ctx.mode === 'tui';
          follow(runner);
        }
        void runner.run();
      },
    });
  };
}

export default createExtension(launchFromRepo);
