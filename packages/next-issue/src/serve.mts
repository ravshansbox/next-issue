import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Args, parseArgs } from './args.mts';
import { loadConfig } from './config.mts';
import { stopChildren } from './exec.mts';
import { detectRepo } from './git.mts';
import { waitingQuestions } from './handover.mts';
import type { Interrupts } from './interrupt.mts';
import { type Fields, hasCode, message } from './observe.mts';
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
import { stateDir } from './state.mts';
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

type Questions = Extract<WorkerMessage, { type: 'questions' | 'questions-error' }>;

type Delivery = { read: number; value: Questions };

type Run = {
  progress: Progress;
  stop: boolean;
  wake?: () => void;
};

function active(run: Run | undefined): boolean {
  return run?.progress.status === 'running' || run?.progress.status === 'stopping';
}

function endStatus(run: Run): Progress['status'] {
  if (run.stop) {
    return 'stopped';
  }
  return run.progress.error === undefined ? 'finished' : 'failed';
}

function startRefusal(run: Run | undefined, restart: boolean): string | undefined {
  if (active(run)) {
    return 'a run is going in this repository already';
  }
  if (restart) {
    return 'the worker is restarting, try again soon';
  }
  return undefined;
}

function endsIssue(record: Fields): boolean {
  return record['kind'] === 'issue.end' || record['kind'] === 'issue.error';
}

function requestStop(run: Run): void {
  run.stop = true;
  run.wake?.();
  run.progress = { ...run.progress, status: 'stopping' };
}

function runInterrupts(run: Run): Interrupts {
  return {
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
}

function runControls(
  run: Run,
  update: (next: Progress) => void,
  issueEnded: () => void,
): RunControls {
  return {
    interrupts: runInterrupts(run),
    onEvent: (record) => {
      update(applyEvent(run.progress, record));
      if (endsIssue(record)) {
        issueEnded();
      }
    },
  };
}

export function workerPaths(root: string): { socketPath: string; lockPath: string } {
  const dir = stateDir(root);
  return {
    socketPath: join(dir, 'worker.sock'),
    lockPath: join(dir, 'worker.lock'),
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
    return hasCode(error, 'EPERM');
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
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
    }
    if ((await holder(path)) === undefined) {
      await rm(path, { force: true });
    } else if (Date.now() >= deadline) {
      return false;
    } else {
      await delay(LOCK_POLL_MS);
    }
  }
}

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

async function listQuestions(root: string): Promise<Question[]> {
  const config = await loadConfig(root);
  return waitingQuestions(await detectRepo(root, config.remote), config, PORTS);
}

async function readQuestions(list: ListQuestions, root: string): Promise<Questions> {
  try {
    return { type: 'questions', root, questions: await list(root) };
  } catch (error) {
    return { type: 'questions-error', root, message: message(error) };
  }
}

function questionsReply(
  delivered: WeakMap<WebSocket, Map<string, Delivery>>,
  socket: WebSocket,
  root: string,
  delivery: Delivery,
  id?: string,
): Questions | undefined {
  const seen = delivered.get(socket) ?? new Map<string, Delivery>();
  const last = seen.get(root);
  if (last === undefined || last.read < delivery.read) {
    seen.set(root, delivery);
    delivered.set(socket, seen);
    return id === undefined ? delivery.value : { ...delivery.value, id };
  }
  return id === undefined ? undefined : { ...last.value, id };
}

type SendQuestions = (
  root: string,
  targets: () => Iterable<WebSocket>,
  id?: string,
) => Promise<void>;

function questionSender(list: ListQuestions): SendQuestions {
  const reads = new Map<string, number>();
  const delivered = new WeakMap<WebSocket, Map<string, Delivery>>();
  return async (root, targets, id) => {
    const read = (reads.get(root) ?? 0) + 1;
    reads.set(root, read);
    const value = await readQuestions(list, root);
    for (const socket of targets()) {
      const reply = questionsReply(delivered, socket, root, { read, value }, id);
      if (reply !== undefined) {
        send(socket, reply);
      }
    }
  };
}

function send(socket: WebSocket, value: WorkerMessage): void {
  socket.send(JSON.stringify(value));
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

function runsMessage(runs: Map<string, Run>): WorkerMessage {
  return {
    type: 'runs',
    runs: Object.fromEntries([...runs].map(([root, run]) => [root, run.progress])),
  };
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

export async function startWorker(options: WorkerOptions): Promise<Worker | undefined> {
  checkSocketPath(options.socketPath);
  await mkdir(dirname(options.lockPath), { recursive: true });
  if (!(await lock(options.lockPath, options.lockWaitMs ?? LOCK_WAIT_MS))) {
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
  const sendQuestions = questionSender(options.questions);
  const busy = (): boolean => [...runs.values()].some(active);

  let closing: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      await shutdown(server, sockets, options);
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
