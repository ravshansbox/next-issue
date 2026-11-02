import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Config = {
  remote: string;
  maxCiFixes: number;
  maxReviewRounds: number;
  checkTimeoutMinutes: number;
  diffMaxChars: number;
  logMaxChars: number;
};

export const CONFIG_FILE = join('.pi', 'next-issue.json');

const DEFAULTS: Config = {
  remote: 'origin',
  maxCiFixes: 3,
  maxReviewRounds: 3,
  checkTimeoutMinutes: 30,
  diffMaxChars: 60000,
  logMaxChars: 20000,
};

const LEAST: Record<Exclude<keyof Config, 'remote'>, number> = {
  maxCiFixes: 0,
  maxReviewRounds: 1,
  checkTimeoutMinutes: 1,
  diffMaxChars: 1,
  logMaxChars: 1,
};

export async function loadConfig(root: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(join(root, CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULTS };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} must hold an object`);
  }
  const config: Config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'remote') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${CONFIG_FILE}: remote must be text that is not empty`);
      }
      config.remote = value;
    } else if (key in LEAST) {
      const least = LEAST[key as keyof typeof LEAST];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < least) {
        throw new Error(`${CONFIG_FILE}: ${key} must be a whole number of ${least} or more`);
      }
      config[key as keyof typeof LEAST] = value;
    } else {
      throw new Error(`${CONFIG_FILE} holds an unknown field: ${key}`);
    }
  }
  return config;
}
