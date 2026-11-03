import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Args, parseArgs } from './args.mts';
import { loadConfig } from './config.mts';
import { stopChildren } from './exec.mts';
import { detectRepo } from './git.mts';
import { waitingQuestions } from './handover.mts';
import type { Interrupts } from './interrupt.mts';
import { message } from './observe.mts';
import { applyEvent, startProgress } from './progress.mts';
import { PORTS } from './ports.mts';
import {
  type ClientMessage,
  isNewer,
  type Progress,
  type Question,
  type WorkerMessage,
} from './protocol.mts';
import { runRepo, type RunControls } from './run.mts';
import { STATE_DIR } from './state.mts';
import { packageVersion } from './version.mts';

export type RunRepo = (root: string, args: Args, controls: RunControls) => Promise<number>;

export type ListQuestions = (root: string) => Promise<Question[]>;

export type WorkerOptions = {
  root: string;
  socketPath: string;
  lockPath: string;
  version: string;
  runRepo: RunRepo;
  questions: ListQuestions;
  lockWaitMs?: number;
  idleMs?: number;
};

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 100;
const IDLE_MS = 30_000;

export type Worker = {
  closed: Promise<void>;
  close: () => Promise<void>;
};

type Run = {
  progress: Progress;
  stop: boolean;
  wake?: () => void;
};

function active(run: Run | undefined): boolean {
  return run?.progress.status === 'running' || run?.progress.status === 'stopping';
}

export function workerPaths(root: string): { socketPath: string; lockPath: string } {
  return {
    socketPath: join(root, STATE_DIR, 'worker.sock'),
    lockPath: join(root, STATE_DIR, 'worker.lock'),
  };
}

export function checkSocketPath(path: string, platform = process.platform): void {
  const size = platform === 'linux' ? 108 : 104;
  const length = Buffer.byteLength(path);
  if (length >= size) {
    throw new Error(
      `the socket path ${path} is too long for this system: ${length} bytes, at most ${size - 1}`,
    );
  }
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

async function lock(path: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    if ((await holder(path)) === undefined) {
      await rm(path, { force: true });
    } else if (Date.now() >= deadline) {
      return false;
    } else {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

export async function listQuestions(root: string): Promise<Question[]> {
  const config = await loadConfig(root);
  return waitingQuestions(await detectRepo(root, config.remote), config, PORTS);
}

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  checkSocketPath(options.socketPath);
  await mkdir(dirname(options.lockPath), { recursive: true });
  if (!(await lock(options.lockPath, options.lockWaitMs ?? LOCK_WAIT_MS))) {
    return undefined;
  }
  await rm(options.socketPath, { force: true });
  const runs = new Map<string, Run>();
  const reads = new Map<string, number>();
  type Questions = Extract<WorkerMessage, { type: 'questions' | 'questions-error' }>;
  const delivered = new WeakMap<WebSocket, Map<string, { read: number; value: Questions }>>();
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
  const sendQuestions = async (
    root: string,
    targets: () => Iterable<WebSocket>,
    id?: string,
  ): Promise<void> => {
    const read = (reads.get(root) ?? 0) + 1;
    reads.set(root, read);
    let value: Questions;
    try {
      value = { type: 'questions', root, questions: await options.questions(root) };
    } catch (error) {
      value = { type: 'questions-error', root, message: message(error) };
    }
    for (const socket of targets()) {
      const seen = delivered.get(socket) ?? new Map<string, { read: number; value: Questions }>();
      const last = seen.get(root);
      if (last === undefined || last.read < read) {
        seen.set(root, { read, value });
        delivered.set(socket, seen);
        send(socket, id === undefined ? value : { ...value, id });
      } else if (id !== undefined) {
        send(socket, { ...last.value, id });
      }
    }
  };
  const busy = (): boolean => [...runs.values()].some(active);

  let closing: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
      await rm(options.lockPath, { force: true });
      finish();
    })();
    return closing;
  };
  const closeWhenIdle = (): void => {
    if ((restart || sockets.clients.size === 0) && !busy()) {
      void close();
    }
  };

  const start = (socket: WebSocket, root: string, merge: boolean): void => {
    if (active(runs.get(root))) {
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
          onEvent: (record) => {
            update(applyEvent(run.progress, record));
            if (record['kind'] === 'issue.end' || record['kind'] === 'issue.error') {
              void sendQuestions(root, () => sockets.clients);
            }
          },
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
      .finally(closeWhenIdle);
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
    void sendQuestions(options.root, () => [socket]);
    socket.on('close', closeWhenIdle);
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
          closeWhenIdle();
        }
      } else if (value.type === 'start') {
        start(socket, value.root, value.merge === true);
      } else if (value.type === 'stop') {
        stop(value.root);
      } else if (value.type === 'questions') {
        void sendQuestions(value.root, () => [socket], value.id);
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
  idleTimer = setTimeout(closeWhenIdle, options.idleMs ?? IDLE_MS);
  return { closed, close };
}

export async function serve(root: string): Promise<number> {
  const paths = workerPaths(root);
  const worker = await startWorker({
    root,
    ...paths,
    version: await packageVersion(),
    runRepo,
    questions: listQuestions,
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
