import type { WorkerClient } from './worker.ts';

const KEY = Symbol.for('pi-next-issue');

export function shared(create: (root: string) => WorkerClient, root: string): WorkerClient {
  const store = globalThis as Record<symbol, Map<string, WorkerClient> | undefined>;
  const clients = (store[KEY] ??= new Map());
  let client = clients.get(root);
  if (client === undefined) {
    client = create(root);
    clients.set(root, client);
  }
  return client;
}
