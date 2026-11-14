import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { hasCode } from './errors.mts';
import { readTextOrEmpty } from './files.mts';

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

async function holder(lockPath: string): Promise<number | undefined> {
  const [first = '', ...rest] = (await readTextOrEmpty(lockPath)).trim().split(' ');
  const pid = Number(first);
  const started = rest.join(' ');
  if (!(pid > 0) || started === '') {
    return undefined;
  }
  return (await processStart(pid)) === started ? pid : undefined;
}

export async function stopWorker(lockPath: string): Promise<number | undefined> {
  const pid = await holder(lockPath);
  if (pid !== undefined) {
    process.kill(pid, 'SIGTERM');
  }
  return pid;
}

export async function lock(path: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(path, `${process.pid} ${await processStart(process.pid)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
    }
    if ((await holder(path)) === undefined) {
      await rm(path, { force: true });
    } else if (Date.now() >= deadline) {
      return false;
    } else {
      await delay(LOCK_POLL_MS);
    }
  }
}
