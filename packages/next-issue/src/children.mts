import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

export type RunChildren = { groups: Set<number>; stoppers: Set<() => void>; stopped: boolean };

const groups = new Set<number>();

const stoppers = new Set<() => void>();

const undos = new Set<() => void>();

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

export function evenWhenStopped<T>(body: () => Promise<T>): Promise<T> {
  return current.run(runChildren(), body);
}

export function refuseWhenStopped(): void {
  if (runStopped()) {
    throw new Error('The run stopped.');
  }
}

export function onStop(stopper: () => void): () => void {
  const children = current.getStore();
  guard();
  stoppers.add(stopper);
  children?.stoppers.add(stopper);
  return () => {
    stoppers.delete(stopper);
    children?.stoppers.delete(stopper);
    unguard();
  };
}

/** Runs `undo` (synchronously) if the process is killed, for a step the kill leaves unsettled. */
export function onKill(undo: () => void): () => void {
  undos.add(undo);
  return () => {
    undos.delete(undo);
  };
}

export function stopChildren(signal: NodeJS.Signals): void {
  stopAll({ groups, stoppers }, signal);
  for (const undo of undos) {
    try {
      undo();
    } catch {}
  }
  undos.clear();
  process.off('SIGTERM', onTerminate);
  process.kill(process.pid, signal);
}

const onTerminate = (): void => stopChildren('SIGTERM');

/** Handles `SIGTERM` while a command or an agent runs, so its process group is stopped too. */
function guard(): void {
  if (groups.size === 0 && stoppers.size === 0) {
    process.on('SIGTERM', onTerminate);
  }
}

function unguard(): void {
  if (groups.size === 0 && stoppers.size === 0) {
    process.off('SIGTERM', onTerminate);
  }
}

export function watch(pid: number | undefined): () => void {
  if (pid === undefined) {
    return () => undefined;
  }
  guard();
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
  unguard();
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
