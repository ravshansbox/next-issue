import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKTREE_DIR } from './git.ts';
import type { IssueState } from './runner.ts';

function dir(root: string): string {
  return join(root, WORKTREE_DIR);
}

function file(root: string, issue: number): string {
  return join(dir(root), `${issue}.json`);
}

export async function readState(root: string, issue: number): Promise<IssueState | undefined> {
  try {
    return JSON.parse(await readFile(file(root, issue), 'utf8')) as IssueState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`the state of #${issue} cannot be read: ${(error as Error).message}`);
  }
}

export async function writeState(root: string, state: IssueState): Promise<void> {
  await mkdir(dir(root), { recursive: true });
  await writeFile(file(root, state.issue), `${JSON.stringify(state, null, 2)}\n`);
}

export async function dropState(root: string, issue: number): Promise<void> {
  await rm(file(root, issue), { force: true });
}

export async function savedIssues(root: string): Promise<number[]> {
  const names = await readdir(dir(root)).catch(() => []);
  return names.flatMap((name) => {
    const match = /^(\d+)\.json$/.exec(name);
    return match === null ? [] : [Number(match[1])];
  });
}

function lockFile(root: string): string {
  return join(dir(root), 'run.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function holder(path: string): Promise<number> {
  return Number((await readFile(path, 'utf8').catch(() => '')).trim());
}

function busy(pid: number, cause: unknown): Error {
  return new Error(`another run works on this repository (pid ${pid})`, { cause });
}

async function place(root: string): Promise<void> {
  const draft = `${lockFile(root)}.${process.pid}.draft`;
  await writeFile(draft, `${process.pid}\n`);
  try {
    await link(draft, lockFile(root));
  } finally {
    await rm(draft, { force: true });
  }
}

async function claim(root: string): Promise<void> {
  try {
    await place(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw busy(await holder(lockFile(root)), error);
    }
    throw error;
  }
}

export async function lock(root: string): Promise<void> {
  await mkdir(dir(root), { recursive: true });
  try {
    await place(root);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const pid = await holder(lockFile(root));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      throw busy(pid, error);
    }
    const stale = `${lockFile(root)}.${process.pid}`;
    try {
      await rename(lockFile(root), stale);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw renameError;
      }
      return claim(root);
    }
    const moved = await holder(stale);
    if (!Object.is(moved, pid)) {
      await link(stale, lockFile(root)).catch(() => undefined);
      await rm(stale, { force: true });
      throw busy(moved, error);
    }
    await rm(stale, { force: true });
  }
  await claim(root);
}

export async function unlock(root: string): Promise<void> {
  if ((await holder(lockFile(root))) === process.pid) {
    await rm(lockFile(root), { force: true });
  }
}
