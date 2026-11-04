import { readdir, readFile } from 'node:fs/promises';

export function readTextOrEmpty(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

export function listOrEmpty(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
