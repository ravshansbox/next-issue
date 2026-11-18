import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Args } from '../src/args.mts';
import type { ClientMessage, WorkerMessage } from '../src/protocol.mts';
import type { ListQuestions } from '../src/questions.mts';
import type { RunControls } from '../src/run.mts';
import { type RunRepo, startWorker } from '../src/serve.mts';
import type { ListUpcoming } from '../src/upcoming.mts';
import { tempDir } from './temp-dir.mts';

export type Client = {
  send: (value: ClientMessage) => void;
  next: (match: (value: WorkerMessage) => boolean) => Promise<WorkerMessage>;
  closed: Promise<void>;
  close: () => Promise<void>;
};

const nextTimeoutMs = 3000;

export async function connect(t: TestContext, socketPath: string): Promise<Client> {
  // A `ws+unix://` URL would percent-encode the path and cut it at `#`, `?` and `:`.
  const socket = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection(socketPath),
  });
  const seen: WorkerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on('message', (data) => {
    seen.push(JSON.parse(String(data)) as WorkerMessage);
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  t.after(() => socket.terminate());
  return {
    send: (value) => socket.send(JSON.stringify(value)),
    next: async (match) => {
      const deadline = Date.now() + nextTimeoutMs;
      for (;;) {
        const index = seen.findIndex(match);
        if (index >= 0) {
          return seen.splice(0, index + 1).at(-1)!;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `client.next timed out after ${nextTimeoutMs} ms waiting for ${String(match)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    closed,
    close: () => {
      socket.close();
      return closed;
    },
  };
}

type Fake = {
  runRepo: RunRepo;
  calls: { root: string; args: Args }[];
  controls: () => RunControls;
  finish: (code?: number) => void;
};

export function fakeRuns(): Fake {
  const calls: { root: string; args: Args }[] = [];
  let controls: RunControls | undefined;
  let finish: (code: number) => void = () => undefined;
  return {
    calls,
    controls: () => controls!,
    finish: (code = 0) => finish(code),
    runRepo: (root, args, given) => {
      calls.push({ root, args });
      controls = given;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
}

export const noQuestions: ListQuestions = async () => [];

export async function worker(
  t: TestContext,
  fake: Fake,
  version = '2.0.0',
  questions: ListQuestions = noQuestions,
  folder?: string,
  upcoming?: ListUpcoming,
) {
  const dir = folder === undefined ? await tempDir() : join(await tempDir(), folder);
  await mkdir(dir, { recursive: true });
  const paths = {
    root: '/repo',
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
  };
  const started = await startWorker({
    ...paths,
    version,
    runRepo: fake.runRepo,
    questions,
    upcoming,
  });
  assert.ok(started);
  t.after(() => started.close());
  return { ...paths, dir, worker: started };
}

export const runsOf = (value: WorkerMessage) => value.type === 'runs';

export type HttpReply = { status: number; body: string };

export function http(
  socketPath: string,
  method: string,
  body?: string,
  path = '/',
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath, method, path }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

export async function post(socketPath: string, value: ClientMessage): Promise<WorkerMessage[]> {
  const reply = await http(socketPath, 'POST', JSON.stringify(value));
  assert.equal(reply.status, 200, reply.body);
  return JSON.parse(reply.body) as WorkerMessage[];
}

export async function poll(socketPath: string): Promise<WorkerMessage[]> {
  const reply = await http(socketPath, 'GET');
  assert.equal(reply.status, 200, reply.body);
  return JSON.parse(reply.body) as WorkerMessage[];
}
