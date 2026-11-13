import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readTextIfPresent, readTextOrEmpty } from './files.mts';
import { git } from './git.mts';

export async function excludeFile(root: string): Promise<string> {
  return join(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
}

export async function ensureExcluded(path: string, entry: string): Promise<boolean> {
  const current = await readTextOrEmpty(path);
  if (current.split('\n').some((line) => line.trim() === entry)) {
    return false;
  }
  const gap = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await mkdir(join(path, '..'), { recursive: true });
  await appendFile(path, `${gap}${entry}\n`);
  return true;
}

export async function removeIgnored(root: string, entries: string[]): Promise<string[]> {
  const path = join(root, '.gitignore');
  const current = await readTextIfPresent(path);
  if (current === undefined) {
    return [];
  }
  const lines = current.split('\n');
  const removed = entries.filter((entry) => lines.some((line) => line.trim() === entry));
  if (removed.length === 0) {
    return [];
  }
  const kept = lines.filter((line) => !removed.includes(line.trim())).join('\n');
  await (kept.trim() === '' ? rm(path) : writeFile(path, kept));
  return removed;
}
