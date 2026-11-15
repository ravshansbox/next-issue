import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Args, parseStartArgs } from './args.mts';
import { stopChildren, withRunChildren } from './children.mts';
import { message } from './errors.mts';
import { lock } from './lock.mts';
import { startProgress } from './progress.mts';
import { type ClientMessage, isNewer, type Progress } from './protocol.mts';
import { type ListQuestions, listQuestions, questionSender, send } from './questions.mts';
import { runRepo, type RunControls } from './run.mts';
import { packageVersion } from './version.mts';
import { keepLogTrimmed, LOG_CHECK_MS } from './worker-log.mts';
import { checkSocketPath, workerPaths } from './worker-paths.mts';
import {
  active,
  endStatus,
  newRun,
  requestStop,
  type Run,
  runControls,
  runsMessage,
  startRefusal,
  stopPoint,
} from './worker-run.mts';
import {
  broadcast,
  closer,
  fileId,
  listen,
  type Owned,
  parseMessage,
  removeOwned,
  shutdown,
  type Worker,
} from './worker-server.mts';

export type RunRepo = (root: string, args: Args, controls: RunControls) => Promise<number>;

type WorkerOptions = {
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

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  checkSocketPath(options.socketPath);
  await mkdir(dirname(options.lockPath), { recursive: true });
  const held = await lock(options.lockPath, options.lockWaitMs ?? LOCK_WAIT_MS);
  if (held === undefined) {
    return undefined;
  }
  const owned: Owned = {
    socketPath: options.socketPath,
    lockPath: options.lockPath,
    lock: held,
    socket: '',
  };
  const runs = new Map<string, Run>();
  let restart = false;

  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const sendQuestions = questionSender(options.questions);
  // Taken outside any run, so a question read that an issue end starts does not take on
  // the run's stop, command log, children or default timeout.
  const outsideRuns = AsyncLocalStorage.snapshot();
  const busy = (): boolean => [...runs.values()].some(active);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const { closed, close } = closer(async () => {
    clearTimeout(idleTimer);
    await shutdown(server, sockets, owned);
  });
  const closeWhenIdle = (): void => {
    if ((restart || sockets.clients.size === 0) && !busy()) {
      void close();
    }
  };

  const start = (socket: WebSocket, root: string, argv: string[]): void => {
    const refusal = startRefusal(runs.get(root), restart);
    if (refusal !== undefined) {
      send(socket, { type: 'error', root, message: refusal });
      return;
    }
    let args: Args;
    try {
      args = parseStartArgs(argv);
    } catch (error) {
      send(socket, { type: 'error', root, message: message(error) });
      return;
    }
    const run = newRun(startProgress());
    runs.set(root, run);
    const update = (next: Progress): void => {
      run.progress = next;
      broadcast(sockets, runs);
    };
    broadcast(sockets, runs);
    withRunChildren(run.children, () =>
      options.runRepo(
        root,
        args,
        runControls(run, update, () =>
          outsideRuns(() => void sendQuestions(root, () => sockets.clients)),
        ),
      ),
    )
      .then(
        () => update({ ...run.progress, status: endStatus(run) }),
        (error: unknown) => update({ ...run.progress, status: 'failed', error: message(error) }),
      )
      .finally(closeWhenIdle);
  };

  const stop = (socket: WebSocket, root: string, after: unknown): void => {
    const point = stopPoint(after);
    if (point === undefined) {
      send(socket, { type: 'error', root, message: `stop does not take --after ${String(after)}` });
    } else if (requestStop(runs.get(root), point)) {
      broadcast(sockets, runs);
    }
  };

  const receive = (socket: WebSocket, value: ClientMessage): void => {
    if (value.type === 'hello') {
      if (isNewer(value.version, options.version)) {
        restart = true;
        closeWhenIdle();
      }
    } else if (value.root !== options.root) {
      send(socket, {
        type: 'error',
        root: value.root,
        message: `the worker serves ${options.root} only`,
      });
    } else if (value.type === 'start') {
      start(socket, value.root, value.args ?? []);
    } else if (value.type === 'stop') {
      stop(socket, value.root, value.after);
    } else if (value.type === 'questions') {
      void sendQuestions(value.root, () => [socket], value.id);
    }
  };

  sockets.on('connection', (socket) => {
    send(socket, { type: 'hello', version: options.version });
    send(socket, runsMessage(runs));
    void sendQuestions(options.root, () => [socket]);
    socket.on('close', closeWhenIdle);
    socket.on('error', () => socket.terminate());
    socket.on('message', (data) => {
      const value = parseMessage(String(data));
      if (value === undefined) {
        return;
      }
      try {
        receive(socket, value);
      } catch (error) {
        send(socket, {
          type: 'error',
          root: value.type === 'hello' ? options.root : value.root,
          message: message(error),
        });
      }
    });
  });

  const draft = join(dirname(options.socketPath), `~${basename(options.socketPath).slice(1)}`);
  await rm(draft, { force: true });
  await listen(server, draft);
  await rename(draft, options.socketPath);
  owned.socket = fileId(options.socketPath);
  idleTimer = setTimeout(closeWhenIdle, options.idleMs ?? IDLE_MS);
  return { closed, close, release: () => removeOwned(owned) };
}

export async function serve(root: string, logCheckMs = LOG_CHECK_MS): Promise<number> {
  const { logPath, ...paths } = workerPaths(root);
  const stopTrimming = keepLogTrimmed(logPath, logCheckMs);
  const worker = await startWorker({
    root,
    ...paths,
    version: await packageVersion(),
    runRepo,
    questions: listQuestions,
  });
  if (worker === undefined) {
    stopTrimming();
    process.stderr.write('next-issue: another worker is running\n');
    return 1;
  }
  const end = (signal: NodeJS.Signals): void => {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangUp);
    worker.release();
    stopChildren(signal);
  };
  const onTerminate = (): void => end('SIGTERM');
  const onInterrupt = (): void => end('SIGINT');
  const onHangUp = (): void => end('SIGHUP');
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  process.on('SIGHUP', onHangUp);
  process.stderr.write(`next-issue: worker listening on ${paths.socketPath}\n`);
  await worker.closed;
  stopTrimming();
  return 0;
}
