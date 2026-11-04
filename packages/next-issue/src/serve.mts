import { rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Args, parseArgs } from './args.mts';
import { stopChildren } from './children.mts';
import { lock } from './lock.mts';
import { message } from './errors.mts';
import { startProgress } from './progress.mts';
import { type ClientMessage, isNewer, type Progress } from './protocol.mts';
import { type ListQuestions, listQuestions, questionSender, send } from './questions.mts';
import { runRepo, type RunControls } from './run.mts';
import { packageVersion } from './version.mts';
import { checkSocketPath, workerPaths } from './worker-paths.mts';
import {
  active,
  endStatus,
  requestStop,
  type Run,
  runControls,
  runsMessage,
  startRefusal,
} from './worker-run.mts';

export type RunRepo = (root: string, args: Args, controls: RunControls) => Promise<number>;

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
const IDLE_MS = 30_000;

export type Worker = {
  closed: Promise<void>;
  close: () => Promise<void>;
};

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const umask = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  });
}

function parseMessage(text: string): ClientMessage | undefined {
  try {
    return JSON.parse(text) as ClientMessage;
  } catch {
    return undefined;
  }
}

function broadcast(sockets: WebSocketServer, runs: Map<string, Run>): void {
  const value = runsMessage(runs);
  for (const socket of sockets.clients) {
    send(socket, value);
  }
}

function stopRun(sockets: WebSocketServer, runs: Map<string, Run>, root: string): void {
  const run = runs.get(root);
  if (run === undefined || run.progress.status !== 'running') {
    return;
  }
  requestStop(run);
  broadcast(sockets, runs);
}

async function shutdown(
  server: Server,
  sockets: WebSocketServer,
  paths: { socketPath: string; lockPath: string },
): Promise<void> {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(paths.socketPath, { force: true });
  await rm(paths.lockPath, { force: true });
}

function closer(stop: () => Promise<void>): Worker {
  let finish: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= stop().then(finish);
    return closing;
  };
  return { closed, close };
}

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  checkSocketPath(options.socketPath);
  await mkdir(dirname(options.lockPath), { recursive: true });
  if (!(await lock(options.lockPath, options.lockWaitMs ?? LOCK_WAIT_MS))) {
    return undefined;
  }
  await rm(options.socketPath, { force: true });
  const runs = new Map<string, Run>();
  let restart = false;

  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const sendQuestions = questionSender(options.questions);
  const busy = (): boolean => [...runs.values()].some(active);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const { closed, close } = closer(async () => {
    clearTimeout(idleTimer);
    await shutdown(server, sockets, options);
  });
  const closeWhenIdle = (): void => {
    if ((restart || sockets.clients.size === 0) && !busy()) {
      void close();
    }
  };

  const start = (socket: WebSocket, root: string, merge: boolean): void => {
    const refusal = startRefusal(runs.get(root), restart);
    if (refusal !== undefined) {
      send(socket, { type: 'error', root, message: refusal });
      return;
    }
    const run: Run = { progress: startProgress(), stop: false };
    runs.set(root, run);
    const update = (next: Progress): void => {
      run.progress = next;
      broadcast(sockets, runs);
    };
    broadcast(sockets, runs);
    options
      .runRepo(
        root,
        { ...parseArgs([]), merge },
        runControls(run, update, () => void sendQuestions(root, () => sockets.clients)),
      )
      .then(
        () => update({ ...run.progress, status: endStatus(run) }),
        (error: unknown) => update({ ...run.progress, status: 'failed', error: message(error) }),
      )
      .finally(closeWhenIdle);
  };

  const receive = (socket: WebSocket, value: ClientMessage): void => {
    if (value.type === 'hello') {
      if (isNewer(value.version, options.version)) {
        restart = true;
        closeWhenIdle();
      }
    } else if (value.type === 'start') {
      start(socket, value.root, value.merge === true);
    } else if (value.type === 'stop') {
      stopRun(sockets, runs, value.root);
    } else if (value.type === 'questions') {
      void sendQuestions(value.root, () => [socket], value.id);
    }
  };

  sockets.on('connection', (socket) => {
    send(socket, { type: 'hello', version: options.version });
    send(socket, runsMessage(runs));
    void sendQuestions(options.root, () => [socket]);
    socket.on('close', closeWhenIdle);
    socket.on('message', (data) => {
      const value = parseMessage(String(data));
      if (value !== undefined) {
        receive(socket, value);
      }
    });
  });

  await listen(server, options.socketPath);
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
