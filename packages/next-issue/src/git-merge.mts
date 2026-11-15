import { join } from 'node:path';
import { failedWith, run, succeeded } from './exec.mts';
import { readTextOrEmpty } from './files.mts';
import { commitEverything } from './git-commit.mts';
import { fetchBase, git, isAncestor, resetHard, succeeds } from './git.mts';

export type MergeStart = { target: string; files: string[] | undefined; unmarked: string[] };

export async function startMerge(cwd: string, base: string, remote: string): Promise<MergeStart> {
  const target = await git(cwd, ['rev-parse', await fetchBase(cwd, base, remote)]);
  const result = await run('git', ['merge', '--no-ff', '--no-commit', target], { cwd });
  if (succeeded(result)) {
    return { target, files: (await merging(cwd)) ? [] : undefined, unmarked: [] };
  }
  const files = await unmergedFiles(cwd);
  if (files.length === 0) {
    throw new Error(`git merge ${target} failed: ${result.stderr.trim()}`);
  }
  const unmarked: string[] = [];
  for (const file of files) {
    if (!(await hasConflictMarkers(cwd, [file]))) {
      unmarked.push(file);
    }
  }
  return { target, files, unmarked };
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  const args = ['diff', '--name-only', '-z', '--diff-filter=U'];
  const listed = await run('git', args, { cwd });
  if (!succeeded(listed)) {
    throw new Error(failedWith(`git ${args.join(' ')}`, listed));
  }
  return listed.stdout.split('\0').filter((file) => file !== '');
}

async function merging(cwd: string): Promise<boolean> {
  return succeeds(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
}

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export type Merge = { before: string; target: string; files: string[] };

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
  const holdsBase = await isAncestor(cwd, merge.target, 'HEAD');
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
