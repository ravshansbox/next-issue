import { readdir, readFile, writeFile } from 'node:fs/promises';
import { hasCode } from './errors.mts';

export function readTextOrEmpty(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

export function listOrEmpty(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJson(path: string, value: unknown, options?: { flag: string }): Promise<void> {
  return writeFile(path, prettyJson(value), options);
}

export async function unlessMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

export function readTextIfPresent(path: string): Promise<string | undefined> {
  return unlessMissing(() => readFile(path, 'utf8'));
}
