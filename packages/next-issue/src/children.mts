import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

export type RunChildren = { groups: Set<number>; stoppers: Set<() => void>; stopped: boolean };

const groups = new Set<number>();

const stoppers = new Set<() => void>();

const current = new AsyncLocalStorage<RunChildren>();

export function runChildren(): RunChildren {
  return { groups: new Set(), stoppers: new Set(), stopped: false };
}

export function withRunChildren<T>(children: RunChildren, body: () => Promise<T>): Promise<T> {
  return current.run(children, body);
}

function stopAll(children: Pick<RunChildren, 'groups' | 'stoppers'>, signal: NodeJS.Signals): void {
  for (const stopper of children.stoppers) {
    stopper();
  }
  children.stoppers.clear();
  for (const pid of children.groups) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
  children.groups.clear();
}

export function stopRunChildren(children: RunChildren): void {
  children.stopped = true;
  stopAll(children, 'SIGINT');
}

export function runStopped(): boolean {
  return current.getStore()?.stopped === true;
}

export function refuseWhenStopped(): void {
  if (runStopped()) {
    throw new Error('The run stopped.');
  }
}

export function onStop(stopper: () => void): () => void {
  const children = current.getStore();
  stoppers.add(stopper);
  children?.stoppers.add(stopper);
  return () => {
    stoppers.delete(stopper);
    children?.stoppers.delete(stopper);
  };
}

export function stopChildren(signal: NodeJS.Signals): void {
  stopAll({ groups, stoppers }, signal);
  process.off('SIGTERM', onTerminate);
  process.kill(process.pid, signal);
}

const onTerminate = (): void => stopChildren('SIGTERM');

export function watch(pid: number | undefined): () => void {
  if (pid === undefined) {
    return () => undefined;
  }
  if (groups.size === 0) {
    process.on('SIGTERM', onTerminate);
  }
  groups.add(pid);
  const children = current.getStore();
  children?.groups.add(pid);
  return () => {
    children?.groups.delete(pid);
    unwatch(pid);
  };
}

function unwatch(pid: number): void {
  groups.delete(pid);
  if (groups.size === 0) {
    process.off('SIGTERM', onTerminate);
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
