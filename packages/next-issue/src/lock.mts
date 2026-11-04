import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode } from './errors.mts';

const LOCK_POLL_MS = 100;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

async function holder(lockPath: string): Promise<number | undefined> {
  const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
  return pid > 0 && alive(pid) ? pid : undefined;
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
      await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
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
