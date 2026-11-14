import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { link, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { hasCode } from './errors.mts';
import { readTextIfPresent, readTextOrEmpty } from './files.mts';

const LOCK_POLL_MS = 100;

const worktreeQueues = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const result = (worktreeQueues.get(root) ?? Promise.resolve()).then(work);
  worktreeQueues.set(
    root,
    result.catch(() => undefined),
  );
  return result;
}

export async function processStart(pid: number): Promise<string | undefined> {
  const stat = await readTextOrEmpty(`/proc/${pid}/stat`);
  if (stat !== '') {
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function holderOf(text: string): Promise<number | undefined> {
  const [first = '', ...rest] = text.trim().split(' ');
  const pid = Number(first);
  const started = rest.join(' ');
  if (!(pid > 0) || started === '') {
    return undefined;
  }
  return (await processStart(pid)) === started ? pid : undefined;
}

async function holder(lockPath: string): Promise<number | undefined> {
  return holderOf(await readTextOrEmpty(lockPath));
}

async function isStale(lockPath: string): Promise<boolean> {
  const text = await readTextIfPresent(lockPath);
  return text !== undefined && (await holderOf(text)) === undefined;
}

export async function stopWorker(lockPath: string): Promise<number | undefined> {
  const pid = await holder(lockPath);
  if (pid !== undefined) {
    process.kill(pid, 'SIGTERM');
  }
  return pid;
}

export type HeldLock = {
  owns: () => boolean;
};

function inode(path: string): number | undefined {
  return statSync(path, { throwIfNoEntry: false })?.ino;
}

async function linked(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

async function removeStale(path: string, filled: string): Promise<void> {
  const breakPath = `${path}.break`;
  if (!(await linked(filled, breakPath))) {
    if (await isStale(breakPath)) {
      await rm(breakPath, { force: true });
    }
    return;
  }
  try {
    if (await isStale(path)) {
      await rm(path, { force: true });
    }
  } finally {
    await rm(breakPath, { force: true });
  }
}

export async function lock(
  path: string,
  waitMs: number,
  readStart: (pid: number) => Promise<string | undefined> = processStart,
): Promise<HeldLock | undefined> {
  const started = await readStart(process.pid);
  if (started === undefined) {
    throw new Error('next-issue: cannot read the start time of the worker process');
  }
  const filled = `${path}.${randomUUID()}`;
  await writeFile(filled, `${process.pid} ${started}\n`, { flag: 'wx', mode: 0o600 });
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await linked(filled, path)) {
        const held = inode(path);
        return { owns: () => held !== undefined && inode(path) === held };
      }
      if ((await holder(path)) === undefined) {
        await removeStale(path, filled);
      } else if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(LOCK_POLL_MS);
    }
  } finally {
    await rm(filled, { force: true });
  }
}
