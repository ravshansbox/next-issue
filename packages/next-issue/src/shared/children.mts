import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

export type RunChildren = { groups: Set<number>; stoppers: Set<() => void>; stopped: boolean };

const groups = new Set<number>();

const stoppers = new Set<() => void>();

const undos = new Set<() => void>();

const current = new AsyncLocalStorage<RunChildren>();

const runs = new Set<RunChildren>();

const STOP_GRACE_MS = 10_000;

export function runChildren(): RunChildren {
  return { groups: new Set(), stoppers: new Set(), stopped: false };
}

export function withRunChildren<T>(children: RunChildren, body: () => Promise<T>): Promise<T> {
  return current.run(children, async () => {
    runs.add(children);
    try {
      return await body();
    } finally {
      runs.delete(children);
    }
  });
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
  const running = [...children.groups];
  stopAll(children, 'SIGINT');
  escalate(running, ['SIGTERM', 'SIGKILL']);
}

function escalate(running: number[], signals: NodeJS.Signals[], ended?: () => void): void {
  const [signal, ...later] = signals;
  if (signal === undefined || running.length === 0) {
    ended?.();
    return;
  }
  setTimeout(() => {
    const left = running.filter((pid) => groups.has(pid));
    for (const pid of left) {
      try {
        process.kill(-pid, signal);
      } catch {}
    }
    escalate(left, later, ended);
  }, STOP_GRACE_MS).unref();
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

let ending: (() => void) | undefined;

export function stopChildren(signal: NodeJS.Signals): void {
  for (const children of runs) {
    children.stopped = true;
  }
  const running = [...groups];
  stopAll({ groups: new Set(running), stoppers }, signal);
  for (const undo of undos) {
    try {
      undo();
    } catch {}
  }
  undos.clear();
  process.off('SIGTERM', onTerminate);
  process.off('SIGHUP', onHangUp);
  const exit = (): void => {
    if (ending === exitOnceEnded) {
      ending = undefined;
      process.kill(process.pid, signal);
    }
  };
  const exitOnceEnded = (): void => {
    if (running.every((pid) => !groups.has(pid))) {
      exit();
    }
  };
  ending = exitOnceEnded;
  escalate(running, ['SIGTERM', 'SIGKILL'], exit);
}

const onTerminate = (): void => stopChildren('SIGTERM');

const onHangUp = (): void => stopChildren('SIGHUP');

/**
 * Handles `SIGTERM` and `SIGHUP` (a closed terminal) while a command or an agent runs,
 * so its process group is stopped too.
 */
function guard(): void {
  if (groups.size === 0 && stoppers.size === 0) {
    process.on('SIGTERM', onTerminate);
    process.on('SIGHUP', onHangUp);
  }
}

function unguard(): void {
  if (groups.size === 0 && stoppers.size === 0) {
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onHangUp);
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
  ending?.();
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
