import { readFile } from 'node:fs/promises';

export function readTextOrEmpty(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}
