import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lines, run } from './exec.mts';
import { commitEverything } from './git-commit.mts';
import { fetchBase, git, resetHard, succeeds } from './git.mts';

export async function startMerge(
  cwd: string,
  base: string,
  remote: string,
): Promise<string[] | undefined> {
  const target = await fetchBase(cwd, base, remote);
  const result = await run('git', ['merge', '--no-ff', '--no-commit', target], { cwd });
  if (result.code === 0) {
    return (await merging(cwd)) ? [] : undefined;
  }
  const listed = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  const files = lines(listed);
  if (files.length === 0) {
    throw new Error(`git merge ${target} failed: ${result.stderr.trim()}`);
  }
  return files;
}

async function merging(cwd: string): Promise<boolean> {
  return succeeds(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
}

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export async function commitMerge(cwd: string, files: string[], message: string): Promise<boolean> {
  if (!(await merging(cwd)) || (await hasConflictMarkers(cwd, files))) {
    return false;
  }
  await commitEverything(cwd, message);
  return true;
}

async function hasConflictMarkers(cwd: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    const text = await readFile(join(cwd, file), 'utf8').catch(() => '');
    if (CONFLICT_MARKER.test(text)) {
      return true;
    }
  }
  return false;
}

export async function abortMerge(cwd: string, target: string): Promise<void> {
  await resetHard(cwd, target);
}
