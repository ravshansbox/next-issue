import { going, type Progress } from './protocol.ts';
import { CLOSED, type WorkerClient } from './worker.ts';

export function accepted(
  client: WorkerClient,
  root: string,
  id: string,
  signal: AbortSignal | undefined,
  done: (progress: Progress | undefined) => boolean = going,
  tool = 'next_issue_start',
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
    const abort = () => finish(new Error(`${tool} was cancelled`));
    const stop = client.subscribe((event) => {
      if (event.type === 'error' && event.root === root && (event.id ?? id) === id) {
        finish(new Error(event.message));
      } else if (event.type === 'closed') {
        finish(new Error(CLOSED));
      } else if (event.type === 'runs' && done(event.runs[root])) {
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
