import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { ClientMessage, IssueProgress, Progress, WorkerMessage } from '../src/protocol.ts';

export type FakeWorker = {
  received: ClientMessage[];
  runs: Record<string, Progress>;
  update: (root: string, progress: Progress) => void;
  reply: (message: WorkerMessage) => void;
  close: () => Promise<void>;
};

export function socketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pi-next-issue-')), 'w.sock');
}

export async function startFakeWorker(
  path: string,
  version = '1.0.0',
  onMessage: (worker: FakeWorker, message: ClientMessage) => void = () => {},
): Promise<FakeWorker> {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const broadcast = (message: WorkerMessage) => {
    for (const client of sockets.clients) {
      client.send(JSON.stringify(message));
    }
  };
  const worker: FakeWorker = {
    received: [],
    runs: {},
    update: (root, progress) => {
      worker.runs[root] = progress;
      broadcast({ type: 'runs', runs: worker.runs });
    },
    reply: broadcast,
    close: async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version }));
    socket.send(JSON.stringify({ type: 'runs', runs: worker.runs }));
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ClientMessage;
      worker.received.push(message);
      onMessage(worker, message);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return worker;
}

export function running(fields: Partial<Progress> = {}): Progress {
  return { status: 'running', issues: [], handled: [], ...fields };
}

export function working(issue: number, fields: Partial<IssueProgress> = {}): IssueProgress {
  return { issue, tools: 0, ...fields };
}

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
