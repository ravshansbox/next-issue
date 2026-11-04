import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Args } from '../src/args.mts';
import type { ClientMessage, WorkerMessage } from '../src/protocol.mts';
import type { ListQuestions } from '../src/questions.mts';
import type { RunControls } from '../src/run.mts';
import { type RunRepo, startWorker } from '../src/serve.mts';
import { tempDir } from './temp-dir.mts';

export type Client = {
  send: (value: ClientMessage) => void;
  next: (match: (value: WorkerMessage) => boolean) => Promise<WorkerMessage>;
  closed: Promise<void>;
  close: () => Promise<void>;
};

export async function connect(t: TestContext, socketPath: string): Promise<Client> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`);
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
      for (;;) {
        const index = seen.findIndex(match);
        if (index >= 0) {
          return seen.splice(0, index + 1).at(-1)!;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
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
  finish: () => void;
};

export function fakeRuns(): Fake {
  const calls: { root: string; args: Args }[] = [];
  let controls: RunControls | undefined;
  let finish: () => void = () => undefined;
  return {
    calls,
    controls: () => controls!,
    finish: () => finish(),
    runRepo: (root, args, given) => {
      calls.push({ root, args });
      controls = given;
      return new Promise((resolve) => {
        finish = () => resolve(0);
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
) {
  const dir = await tempDir();
  const paths = {
    root: '/repo',
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
  };
  const started = await startWorker({ ...paths, version, runRepo: fake.runRepo, questions });
  assert.ok(started);
  t.after(() => started.close());
  return { ...paths, dir, worker: started };
}

export const runsOf = (value: WorkerMessage) => value.type === 'runs';
