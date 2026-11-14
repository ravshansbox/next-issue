import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { link, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { hasCode } from './errors.mts';
import { readTextOrEmpty, unlessMissing } from './files.mts';

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

export async function lockHolder(lockPath: string): Promise<number | undefined> {
  return holderOf(await readTextOrEmpty(lockPath));
}

type LockState = { state: 'missing' } | { state: 'stale' | 'held'; id: string };

function idOf(found: { dev: number; ino: number }): string {
  return `${found.dev}:${found.ino}`;
}

function draftPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}`;
}

async function lockState(path: string): Promise<LockState> {
  const read = await unlessMissing(async () => {
    const file = await open(path, 'r');
    try {
      return { id: idOf(await file.stat()), text: await file.readFile('utf8') };
    } finally {
      await file.close();
    }
  });
  if (read === undefined) {
    return { state: 'missing' };
  }
  return { state: (await holderOf(read.text)) === undefined ? 'stale' : 'held', id: read.id };
}

async function take(path: string, text: string): Promise<string | undefined> {
  const draft = draftPath(path);
  await writeFile(draft, text, { flag: 'wx', mode: 0o600 });
  try {
    await link(draft, path);
    return idOf(await stat(draft));
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error;
    }
    return undefined;
  } finally {
    await rm(draft, { force: true });
  }
}

async function removeIfSame(path: string, id: string): Promise<void> {
  const moved = draftPath(path);
  try {
    await rename(path, moved);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  try {
    if (idOf(await stat(moved)) !== id) {
      await link(moved, path).catch((error: unknown) => {
        if (!hasCode(error, 'EEXIST')) {
          throw error;
        }
      });
    }
  } finally {
    await rm(moved, { force: true });
  }
}

async function removeStale(path: string, text: string): Promise<void> {
  const guard = `${path}.break`;
  if ((await take(guard, text)) === undefined) {
    const found = await lockState(guard);
    if (found.state === 'stale') {
      await removeIfSame(guard, found.id);
    } else if (found.state === 'held') {
      await delay(LOCK_POLL_MS);
    }
    return;
  }
  try {
    const found = await lockState(path);
    if (found.state === 'stale') {
      await removeIfSame(path, found.id);
    }
  } finally {
    await rm(guard, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

async function removeDeadDrafts(path: string): Promise<void> {
  const name = basename(path);
  for (const entry of await readdir(dirname(path))) {
    const pid = /^\.(?:break\.)?(\d+)\.[0-9a-f-]{36}$/.exec(entry.slice(name.length))?.[1];
    if (entry.startsWith(name) && pid !== undefined && !isAlive(Number(pid))) {
      await rm(join(dirname(path), entry), { force: true });
    }
  }
}

export async function stopWorker(lockPath: string): Promise<number | undefined> {
  const pid = await lockHolder(lockPath);
  if (pid !== undefined) {
    process.kill(pid, 'SIGTERM');
  }
  return pid;
}

export type HeldLock = {
  owns: () => boolean;
};

function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function heldLock(path: string, id: string, text: string): HeldLock {
  return {
    owns: () => {
      const found = statSync(path, { throwIfNoEntry: false });
      return found !== undefined && idOf(found) === id && textOf(path) === text;
    },
  };
}

export async function lock(
  path: string,
  waitMs: number,
  readStart: (pid: number) => Promise<string | undefined> = processStart,
): Promise<HeldLock | undefined> {
  const started = await readStart(process.pid);
  if (started === undefined) {
    throw new Error('next-issue: cannot read the start time of this process');
  }
  const text = `${process.pid} ${started}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const id = await take(path, text);
    if (id !== undefined) {
      await removeDeadDrafts(path);
      return heldLock(path, id, text);
    }
    const found = await lockState(path);
    if (found.state === 'stale') {
      await removeStale(path, text);
    } else if (found.state === 'held') {
      if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(LOCK_POLL_MS);
    }
  }
}
