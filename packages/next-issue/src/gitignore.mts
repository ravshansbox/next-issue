import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextOrEmpty } from './files.mts';

export async function ensureIgnored(root: string, entry: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  const current = await readTextOrEmpty(path);
  if (current.split('\n').some((line) => line.trim() === entry)) {
    return false;
  }
  const gap = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await appendFile(path, `${gap}${entry}\n`);
  return true;
}
