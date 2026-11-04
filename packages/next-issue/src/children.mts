import type { ChildProcess } from 'node:child_process';

const groups = new Set<number>();

const stoppers = new Set<() => void>();

export function onStop(stopper: () => void): () => void {
  stoppers.add(stopper);
  return () => stoppers.delete(stopper);
}

export function stopChildren(signal: NodeJS.Signals): void {
  for (const stopper of stoppers) {
    stopper();
  }
  stoppers.clear();
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
  groups.clear();
  process.off('SIGTERM', onTerminate);
  process.kill(process.pid, signal);
}

const onTerminate = (): void => stopChildren('SIGTERM');

export function watch(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (groups.size === 0) {
    process.on('SIGTERM', onTerminate);
  }
  groups.add(pid);
}

export function unwatch(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
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
