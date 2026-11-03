import { rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Args, parseArgs } from './args.mts';
import { stopChildren } from './exec.mts';
import type { Interrupts } from './interrupt.mts';
import { message } from './observe.mts';
import { applyEvent, type Progress, startProgress } from './progress.mts';
import { runRepo, type RunControls } from './run.mts';
import { packageVersion } from './version.mts';

export type ClientMessage =
  | { type: 'hello'; version: string }
  | { type: 'start'; root: string; merge: boolean }
  | { type: 'stop'; root: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'error'; root: string; message: string };

export type RunRepo = (root: string, args: Args, controls: RunControls) => Promise<number>;

export type WorkerOptions = {
  socketPath: string;
  lockPath: string;
  version: string;
  runRepo: RunRepo;
};

export type Worker = {
  closed: Promise<void>;
  close: () => Promise<void>;
};

type Run = {
  progress: Progress;
  stop: boolean;
  wake?: () => void;
};

export function socketPaths(agentDir = getAgentDir()): { socketPath: string; lockPath: string } {
  return {
    socketPath: join(agentDir, 'next-issue.sock'),
    lockPath: join(agentDir, 'next-issue.lock'),
  };
}

export function isNewer(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function holder(lockPath: string): Promise<number | undefined> {
  const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
  return pid > 0 && alive(pid) ? pid : undefined;
}

export async function stopWorker(lockPath: string): Promise<number | undefined> {
  const pid = await holder(lockPath);
  if (pid !== undefined) {
    process.kill(pid, 'SIGTERM');
  }
  return pid;
}

async function lock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if ((await holder(path)) !== undefined) {
        return false;
      }
      await rm(path, { force: true });
    }
  }
  return false;
}

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  if (!(await lock(options.lockPath))) {
    return undefined;
  }
  await rm(options.socketPath, { force: true });
  const runs = new Map<string, Run>();
  let restart = false;
  let finish: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const snapshot = (): WorkerMessage => ({
    type: 'runs',
    runs: Object.fromEntries([...runs].map(([root, run]) => [root, run.progress])),
  });
  const send = (socket: WebSocket, value: WorkerMessage): void => {
    socket.send(JSON.stringify(value));
  };
  const broadcast = (): void => {
    const value = snapshot();
    for (const socket of sockets.clients) {
      send(socket, value);
    }
  };
  const busy = (): boolean =>
    [...runs.values()].some(
      (run) => run.progress.status === 'running' || run.progress.status === 'stopping',
    );

  const close = async (): Promise<void> => {
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(options.socketPath, { force: true });
    await rm(options.lockPath, { force: true });
    finish();
  };
  const restartWhenIdle = (): void => {
    if (restart && !busy()) {
      void close();
    }
  };

  const start = (socket: WebSocket, root: string, merge: boolean): void => {
    const current = runs.get(root);
    if (current?.progress.status === 'running' || current?.progress.status === 'stopping') {
      send(socket, { type: 'error', root, message: 'a run is going in this repository already' });
      return;
    }
    if (restart) {
      send(socket, { type: 'error', root, message: 'the worker is restarting, try again soon' });
      return;
    }
    const run: Run = { progress: startProgress(), stop: false };
    runs.set(root, run);
    const interrupts: Interrupts = {
      afterIssue: () => run.stop,
      afterRound: () => run.stop,
      sleep: (ms) =>
        new Promise((resolve) => {
          if (run.stop) {
            resolve(false);
            return;
          }
          const timer = setTimeout(() => resolve(true), ms);
          run.wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        }),
    };
    const update = (next: Progress): void => {
      run.progress = next;
      broadcast();
    };
    broadcast();
    options
      .runRepo(
        root,
        { ...parseArgs([]), merge },
        {
          interrupts,
          onEvent: (record) => update(applyEvent(run.progress, record)),
        },
      )
      .then(
        () => {
          const status = run.stop
            ? 'stopped'
            : run.progress.error === undefined
              ? 'finished'
              : 'failed';
          update({ ...run.progress, status });
        },
        (error: unknown) => update({ ...run.progress, status: 'failed', error: message(error) }),
      )
      .finally(restartWhenIdle);
  };

  const stop = (root: string): void => {
    const run = runs.get(root);
    if (run === undefined || run.progress.status !== 'running') {
      return;
    }
    run.stop = true;
    run.wake?.();
    run.progress = { ...run.progress, status: 'stopping' };
    broadcast();
  };

  sockets.on('connection', (socket) => {
    send(socket, { type: 'hello', version: options.version });
    send(socket, snapshot());
    socket.on('message', (data) => {
      let value: ClientMessage;
      try {
        value = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      if (value.type === 'hello') {
        if (isNewer(value.version, options.version)) {
          restart = true;
          restartWhenIdle();
        }
      } else if (value.type === 'start') {
        start(socket, value.root, value.merge === true);
      } else if (value.type === 'stop') {
        stop(value.root);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const umask = process.umask(0o177);
    try {
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  });
  return { closed, close };
}

export async function serve(): Promise<number> {
  const paths = socketPaths();
  const worker = await startWorker({
    ...paths,
    version: await packageVersion(),
    runRepo,
  });
  if (worker === undefined) {
    process.stderr.write('next-issue: another worker is running\n');
    return 1;
  }
  const end = (signal: NodeJS.Signals): void => {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.lockPath, { force: true });
    stopChildren(signal);
  };
  const onTerminate = (): void => end('SIGTERM');
  const onInterrupt = (): void => end('SIGINT');
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  process.stderr.write(`next-issue: worker listening on ${paths.socketPath}\n`);
  await worker.closed;
  return 0;
}
