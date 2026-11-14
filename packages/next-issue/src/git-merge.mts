import { join } from 'node:path';
import { run, succeeded } from './exec.mts';
import { readTextOrEmpty } from './files.mts';
import { commitEverything } from './git-commit.mts';
import { fetchBase, git, isAncestor, remoteRef, resetHard, succeeds } from './git.mts';
import { lines } from './text.mts';

export type MergeStart = { target: string; files: string[] | undefined };

export async function startMerge(cwd: string, base: string, remote: string): Promise<MergeStart> {
  const target = await git(cwd, ['rev-parse', await fetchBase(cwd, base, remote)]);
  const result = await run('git', ['merge', '--no-ff', '--no-commit', target], { cwd });
  if (succeeded(result)) {
    return { target, files: (await merging(cwd)) ? [] : undefined };
  }
  const listed = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  const files = lines(listed);
  if (files.length === 0) {
    throw new Error(`git merge ${target} failed: ${result.stderr.trim()}`);
  }
  return { target, files };
}

async function merging(cwd: string): Promise<boolean> {
  return succeeds(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
}

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export type Merge = { before: string; base: string; remote: string; files: string[] };

export async function commitMerge(cwd: string, merge: Merge, message: string): Promise<boolean> {
  if (!(await merging(cwd))) {
    await refuseUnmerged(cwd, merge);
    return false;
  }
  if (await hasConflictMarkers(cwd, merge.files)) {
    return false;
  }
  await commitEverything(cwd, message);
  return true;
}

async function refuseUnmerged(cwd: string, merge: Merge): Promise<void> {
  const holdsBase = await isAncestor(cwd, remoteRef(merge.remote, merge.base), 'HEAD');
  if (!holdsBase || (await hasConflictMarkers(cwd, merge.files))) {
    await resetHard(cwd, merge.before);
  }
}

async function hasConflictMarkers(cwd: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    const text = await readTextOrEmpty(join(cwd, file));
    if (CONFLICT_MARKER.test(text)) {
      return true;
    }
  }
  return false;
}

export async function abortMerge(cwd: string, target: string): Promise<void> {
  await resetHard(cwd, target);
}
