import { randomUUID } from 'node:crypto';
import { going, type Question } from './protocol.ts';
import { CLOSED, type WorkerClient } from './worker.ts';

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
    const ours = (event: { root: string; id?: string }) => event.root === root && event.id === id;
    const stop = client.subscribe((event) => {
      if (event.type === 'closed') {
        stop();
        reject(new Error(CLOSED));
      } else if (event.type === 'questions' && ours(event)) {
        stop();
        resolve(event.questions);
      } else if (event.type === 'questions-error' && ours(event)) {
        stop();
        reject(new Error(event.message));
      }
    });
    if (!client.connected) {
      stop();
      reject(new Error(CLOSED));
      return;
    }
    client.send({ type: 'questions', root, id });
  });
}
