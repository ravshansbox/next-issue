import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { lockHolder } from './lock.mts';
import {
  type ClientMessage,
  isNewer,
  type Launch,
  type Progress,
  type WorkerMessage,
} from './protocol.mts';
import { checkSocketPath, workerPaths } from './worker-paths.mts';

export type Connection = {
  version: string;
  runs: Record<string, Progress>;
  send: (message: ClientMessage) => void;
  listen: (listener: (message: WorkerMessage) => void) => void;
  closed: Promise<void>;
  close: () => void;
};

const ANSWER_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 30_000;
const HOLDER_GRACE_MS = 2_000;
const POLL_MS = 200;
const UPGRADE_TRIES = 3;

export const CLOSED = 'the worker closed the connection';

class SilentWorker extends Error {
  constructor() {
    super('the next-issue worker did not answer');
  }
}

export function going(progress: Progress | undefined): boolean {
  return progress?.status === 'running' || progress?.status === 'stopping';
}

function parse(text: string): WorkerMessage | undefined {
  try {
    return JSON.parse(text) as WorkerMessage;
  } catch {
    return undefined;
  }
}

function ownLaunch(): Launch {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, 'serve'] };
}

function open(socketPath: string, version?: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection(socketPath),
    });
    const closed = new Promise<void>((done) => socket.once('close', () => done()));
    const queued: WorkerMessage[] = [];
    let listener: ((message: WorkerMessage) => void) | undefined;
    let workerVersion = '0.0.0';
    let ready = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new SilentWorker());
    }, ANSWER_TIMEOUT_MS);
    const fail = (error: Error): void => {
      if (!ready) {
        clearTimeout(timer);
        reject(error);
      }
    };
    socket.on('error', fail);
    socket.once('close', () => fail(new Error(CLOSED)));
    socket.on('message', (data) => {
      const message = parse(String(data));
      if (message === undefined) {
        return;
      }
      if (ready) {
        if (listener === undefined) {
          queued.push(message);
        } else {
          listener(message);
        }
      } else if (message.type === 'hello') {
        workerVersion = message.version;
      } else if (message.type === 'runs') {
        ready = true;
        clearTimeout(timer);
        if (version !== undefined && !Object.values(message.runs).some(going)) {
          socket.send(JSON.stringify({ type: 'hello', version, launch: ownLaunch() }));
        }
        resolve({
          version: workerVersion,
          runs: message.runs,
          send: (value) => socket.send(JSON.stringify(value)),
          listen: (next) => {
            listener = next;
            queued.splice(0).forEach(next);
          },
          closed,
          close: () => socket.terminate(),
        });
      }
    });
  });
}

async function tryOpen(socketPath: string, version?: string): Promise<Connection | undefined> {
  try {
    return await open(socketPath, version);
  } catch (error) {
    if (error instanceof SilentWorker) {
      throw error;
    }
    return undefined;
  }
}

async function waitForHolder(
  paths: ReturnType<typeof workerPaths>,
  version: string | undefined,
): Promise<Connection | undefined> {
  const deadline = Date.now() + HOLDER_GRACE_MS;
  for (;;) {
    if ((await lockHolder(paths.lockPath)) === undefined || Date.now() >= deadline) {
      return undefined;
    }
    await delay(POLL_MS);
    const opened = await tryOpen(paths.socketPath, version);
    if (opened !== undefined) {
      return opened;
    }
  }
}

async function waitForStart(
  paths: ReturnType<typeof workerPaths>,
  version: string | undefined,
  exited: () => string | undefined,
): Promise<Connection> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    await delay(POLL_MS);
    const reason = exited();
    const opened = await tryOpen(paths.socketPath, version);
    if (opened !== undefined) {
      return opened;
    }
    if (reason !== undefined) {
      throw new Error(`the next-issue worker exited before it listened: ${reason}`);
    }
    if (Date.now() >= deadline) {
      throw new Error('the next-issue worker did not start (see .next-issue/worker.log)');
    }
  }
}

async function launch(root: string, version: string | undefined, how: Launch): Promise<Connection> {
  const paths = workerPaths(root);
  const held = await waitForHolder(paths, version);
  if (held !== undefined) {
    return held;
  }
  let exited: string | undefined;
  spawnServe(root, how, (reason) => {
    exited ??= reason;
  });
  return waitForStart(paths, version, () => exited);
}

export async function reachWorker(root: string, version: string): Promise<Connection> {
  const { socketPath } = workerPaths(root);
  checkSocketPath(socketPath);
  for (let tries = 1; ; tries += 1) {
    const found =
      (await tryOpen(socketPath, version)) ?? (await launch(root, version, ownLaunch()));
    const busy = Object.values(found.runs).some(going);
    if (!isNewer(version, found.version) || busy || tries >= UPGRADE_TRIES) {
      return found;
    }
    await Promise.race([found.closed, delay(ANSWER_TIMEOUT_MS)]);
    found.close();
  }
}

function startedRun(found: Connection, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the newer worker did not start the run')),
      ANSWER_TIMEOUT_MS,
    );
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    found.listen((message) => {
      if (message.type === 'runs' && going(message.runs[root])) {
        settle();
      } else if (message.type === 'error' && message.root === root) {
        settle(new Error(message.message));
      }
    });
    void found.closed.then(() => settle(new Error(CLOSED)));
  });
}

export async function resumeOnSuccessor(root: string, how: Launch, args: string[]): Promise<void> {
  const { socketPath } = workerPaths(root);
  const found = (await tryOpen(socketPath)) ?? (await launch(root, undefined, how));
  try {
    if (!going(found.runs[root])) {
      found.send({ type: 'start', root, args, resume: true });
      await startedRun(found, root);
    }
  } finally {
    found.close();
  }
}

export async function rejoinRun(root: string): Promise<Connection | undefined> {
  const { socketPath } = workerPaths(root);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await tryOpen(socketPath);
    if (found !== undefined && going(found.runs[root])) {
      return found;
    }
    found?.close();
    await delay(POLL_MS);
  }
  return undefined;
}

export function findWorker(root: string): Promise<Connection | undefined> {
  const { socketPath } = workerPaths(root);
  checkSocketPath(socketPath);
  return tryOpen(socketPath);
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code}` : `signal ${signal}`;
}

function spawnServe(root: string, how: Launch, onExit: (reason: string) => void): void {
  const { logPath } = workerPaths(root);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const child = spawn(how.command, how.args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', (error) => onExit(`the worker failed to start: ${error.message}`));
    child.on('exit', (code, signal) => {
      onExit(`${exitText(code, signal)} (see .next-issue/worker.log)`);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}
