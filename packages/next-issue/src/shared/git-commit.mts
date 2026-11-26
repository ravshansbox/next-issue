import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message } from './errors.mts';
import { git, isDirty } from './git.mts';

export class HookError extends Error {}

type CommitOptions = { hooks?: boolean };

export async function commitAll(
  cwd: string,
  commitMessage: string,
  options: CommitOptions = {},
): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await commitEverything(cwd, commitMessage, options);
  return true;
}

export async function saveSetupOutput(cwd: string): Promise<void> {
  await commitAll(cwd, 'chore: setup output', { hooks: false });
}

export async function commitEverything(
  cwd: string,
  commitMessage: string,
  { hooks = true }: CommitOptions = {},
): Promise<void> {
  await git(cwd, ['add', '-A']);
  if (!hooks) {
    await git(cwd, ['commit', '--no-verify', '-m', commitMessage]);
    return;
  }
  const folder = await mkdtemp(join(tmpdir(), 'next-issue-message-'));
  const file = join(folder, 'COMMIT_EDITMSG');
  try {
    await writeFile(file, `${commitMessage}\n`);
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
