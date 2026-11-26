import { rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { HeldLock } from '../shared/lock.mts';
import type { ClientMessage, Launch, WorkerMessage } from '../shared/protocol.mts';
import { type Run, runsMessage } from './worker-run.mts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isLaunch(value: unknown): value is Launch {
  return isRecord(value) && typeof value['command'] === 'string' && isStringArray(value['args']);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return false;
  }
  if (value['type'] === 'hello') {
    return true;
  }
  if (typeof value['root'] !== 'string') {
    return false;
  }
  if (value['id'] !== undefined && typeof value['id'] !== 'string') {
    return false;
  }
  if (value['type'] === 'hunt' || value['type'] === 'watch') {
    return typeof value['on'] === 'boolean';
  }
  return value['type'] !== 'start' || value['args'] === undefined || isStringArray(value['args']);
}

export function parseMessage(text: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isClientMessage(value) ? value : undefined;
}

export type Peer = { send: (data: string, sent?: () => void) => void };

export function send(socket: Peer, value: WorkerMessage): void {
  socket.send(JSON.stringify(value));
}

export function broadcast(
  sockets: WebSocketServer,
  runs: Map<string, Run>,
  maxBufferedBytes: number,
): void {
  sendAll(sockets, runsMessage(runs), maxBufferedBytes);
}

export function sendAll(
  sockets: WebSocketServer,
  value: WorkerMessage,
  maxBufferedBytes: number,
): void {
  for (const socket of sockets.clients) {
    send(socket, value);
    if (socket.bufferedAmount > maxBufferedBytes) {
      socket.terminate();
    }
  }
}

export async function sendAllSent(
  sockets: WebSocketServer,
  value: WorkerMessage,
  limitMs: number,
): Promise<void> {
  const text = JSON.stringify(value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  await Promise.race([
    Promise.all(
      [...sockets.clients].map(
        (socket) => new Promise<void>((resolve) => socket.send(text, () => resolve())),
      ),
    ),
    late,
  ]);
  clearTimeout(timer);
}

export function listen(server: Server, path: string): Promise<void> {
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

function whenClosed(close: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => close(() => resolve()));
}

export function stopListening(server: Server): Promise<void> {
  return whenClosed((done) => server.close(done));
}

export type Owned = { socketPath: string; lockPath: string; lock: HeldLock; socket: string };

export function fileId(path: string): string {
  const found = statSync(path, { throwIfNoEntry: false });
  return found?.isSocket() === true ? `${found.dev}:${found.ino}` : '';
}

export function removeOwned(owned: Owned): void {
  if (owned.socket !== '' && fileId(owned.socketPath) === owned.socket) {
    rmSync(owned.socketPath, { force: true });
  }
  if (owned.lock.owns()) {
    rmSync(owned.lockPath, { force: true });
  }
}

export async function shutdown(
  server: Server,
  sockets: WebSocketServer,
  owned: Owned,
  listening?: Promise<void>,
): Promise<void> {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  await whenClosed((done) => sockets.close(done));
  await (listening ?? stopListening(server));
  removeOwned(owned);
}

export type Worker = {
  closed: Promise<number>;
  close: () => Promise<void>;
  release: () => void;
  exit: (fields: Record<string, unknown>, below?: string) => void;
  signalled: () => void;
};

export function closer(stop: () => Promise<number>): Pick<Worker, 'closed' | 'close'> {
  let finish: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= stop().then(finish);
    return closing;
  };
  return { closed, close };
}
