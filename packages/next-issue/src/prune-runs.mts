import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { daysToMs } from './durations.mts';
import { listOrEmpty } from './files.mts';
import { runsDir } from './state.mts';

export async function pruneRuns(root: string, keepDays: number): Promise<number> {
  if (keepDays <= 0) {
    return 0;
  }
  const dir = runsDir(root);
  const names = await listOrEmpty(dir);
  const cutoff = Date.now() - daysToMs(keepDays);
  let dropped = 0;
  for (const name of names) {
    if (await dropIfOlder(join(dir, name), cutoff)) {
      dropped += 1;
    }
  }
  return dropped;
}

async function dropIfOlder(path: string, cutoff: number): Promise<boolean> {
  try {
    if ((await newestChange(path)) >= cutoff) {
      return false;
    }
    await rm(path, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function newestChange(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.mtimeMs;
  }
  let newest = info.mtimeMs;
  for (const name of await readdir(path)) {
    newest = Math.max(newest, await newestChange(join(path, name)));
  }
  return newest;
}
