import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message } from './errors.mts';
import { git, isDirty } from './git.mts';

export class HookError extends Error {}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await commitEverything(cwd, message);
  return true;
}

export async function commitEverything(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  const folder = await mkdtemp(join(tmpdir(), 'next-issue-message-'));
  const file = join(folder, 'COMMIT_EDITMSG');
  try {
    await writeFile(file, `${message}\n`);
    await runHook(cwd, 'pre-commit');
    await runHook(cwd, 'commit-msg', file);
    await git(cwd, ['commit', '--no-verify', '-F', file]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function runHook(cwd: string, name: string, ...args: string[]): Promise<void> {
  try {
    await git(cwd, ['hook', 'run', '--ignore-missing', name, '--', ...args]);
  } catch (error) {
    throw new HookError(message(error));
  }
}
