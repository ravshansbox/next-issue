import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { ClientMessage } from './protocol.mts';
import { send } from './questions.mts';
import { type Run, runsMessage } from './worker-run.mts';

export function parseMessage(text: string): ClientMessage | undefined {
  try {
    return JSON.parse(text) as ClientMessage;
  } catch {
    return undefined;
  }
}

export function broadcast(sockets: WebSocketServer, runs: Map<string, Run>): void {
  const value = runsMessage(runs);
  for (const socket of sockets.clients) {
    send(socket, value);
  }
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

export async function shutdown(
  server: Server,
  sockets: WebSocketServer,
  paths: { socketPath: string; lockPath: string },
): Promise<void> {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  await whenClosed((done) => sockets.close(done));
  await whenClosed((done) => server.close(done));
  await rm(paths.socketPath, { force: true });
  await rm(paths.lockPath, { force: true });
}

export type Worker = {
  closed: Promise<void>;
  close: () => Promise<void>;
};

export function closer(stop: () => Promise<void>): Worker {
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
