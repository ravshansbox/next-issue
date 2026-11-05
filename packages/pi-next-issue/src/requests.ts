import { randomUUID } from 'node:crypto';
import { going, type Question } from './protocol.ts';
import type { WorkerClient } from './worker.ts';

const CLOSED = 'the worker closed the connection';

export function accepted(
  client: WorkerClient,
  root: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      stop();
      signal?.removeEventListener('abort', abort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const abort = () => finish(new Error('next_issue_start was cancelled'));
    const stop = client.subscribe((event) => {
      if (event.type === 'error' && event.root === root) {
        finish(new Error(event.message));
      } else if (event.type === 'closed') {
        finish(new Error(CLOSED));
      } else if (event.type === 'runs' && going(event.runs[root])) {
        finish();
      }
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

export function fresh(client: WorkerClient, root: string): Promise<Question[]> {
  return new Promise<Question[]>((resolve, reject) => {
    const id = randomUUID();
    const stop = client.subscribe((event) => {
      if (event.type === 'closed') {
        stop();
        reject(new Error(CLOSED));
      } else if (
        (event.type === 'questions' || event.type === 'questions-error') &&
        event.root === root &&
        event.id === id
      ) {
        stop();
        if (event.type === 'questions') {
          resolve(event.questions);
        } else {
          reject(new Error(event.message));
        }
      }
    });
    client.send({ type: 'questions', root, id });
  });
}
