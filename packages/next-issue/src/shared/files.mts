import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hasCode } from './errors.mts';

export function readTextOrEmpty(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

export function listOrEmpty(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

function sortedJson(value: unknown): string {
  return prettyJson(sortKeys(value));
}

export function writeJson(path: string, value: unknown, options?: { flag: string }): Promise<void> {
  return writeFile(path, sortedJson(value), options);
}

export async function replaceJson(path: string, value: unknown): Promise<void> {
  const draft = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(draft, sortedJson(value));
    await rename(draft, path);
  } catch (error) {
    await rm(draft, { force: true });
    throw error;
  }
}

export function replaceJsonNow(path: string, value: unknown): void {
  const draft = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(draft, sortedJson(value));
    renameSync(draft, path);
  } catch (error) {
    rmSync(draft, { force: true });
    throw error;
  }
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
