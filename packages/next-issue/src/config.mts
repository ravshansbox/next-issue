import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONFIG_FILE,
  OLD_CONFIG_FILE,
  record,
  rejectUnknown,
  text,
  whole,
} from './config-fields.mts';
import { MAX_TIMER_MS } from './durations.mts';
import { hasCode, message, parseJson } from './errors.mts';
import { readTextIfPresent, unlessMissing, writeJson } from './files.mts';

export type Config = {
  remote: string;
  issueLimit: number;
  concurrency: number;
  huntCap: number;
  maxCiFixes: number;
  maxCommitFixes: number;
  maxReviewRounds: number;
  checkIntervalSeconds: number;
  checkGraceSeconds: number;
  checkTimeoutMinutes: number;
  agentTimeoutMinutes: number;
  setupTimeoutMinutes: number;
  commandTimeoutMinutes: number;
  logMaxChars: number;
  diffMaxChars: number;
  keepRunDays: number;
  setupCommand?: string;
  models: {
    implementer?: string;
    reviewer?: string;
    fixer?: string;
  };
  labels: {
    ready: string;
    inProgress: string;
    inReview: string;
    done: string;
    needsHuman: string;
    skip: string;
    hunt: string;
  };
};

const DEFAULTS: Config = {
  remote: 'origin',
  issueLimit: 100,
  concurrency: 1,
  huntCap: 1,
  maxCiFixes: 5,
  maxCommitFixes: 10,
  maxReviewRounds: 5,
  checkIntervalSeconds: 15,
  checkGraceSeconds: 60,
  checkTimeoutMinutes: 60,
  agentTimeoutMinutes: 30,
  setupTimeoutMinutes: 15,
  commandTimeoutMinutes: 10,
  logMaxChars: 20000,
  diffMaxChars: 60000,
  keepRunDays: 7,
  models: {},
  labels: {
    ready: 'status:todo',
    inProgress: 'status:in-progress',
    inReview: 'status:in-review',
    done: 'status:done',
    needsHuman: 'status:needs-human',
    skip: 'status:blocked',
    hunt: 'source:hunt',
  },
};

function defaults(): Config {
  return { ...DEFAULTS, models: { ...DEFAULTS.models }, labels: { ...DEFAULTS.labels } };
}

const FIELDS: string[] = [...Object.keys(DEFAULTS), 'setupCommand'];

const MAX_MINUTES = Math.floor(MAX_TIMER_MS / 60_000);
const MAX_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

const WHOLE_FIELDS: Array<[keyof Config, number, number?]> = [
  ['issueLimit', 1],
  ['concurrency', 1],
  ['huntCap', 1],
  ['maxCiFixes', 0],
  ['maxCommitFixes', 0],
  ['maxReviewRounds', 1],
  ['checkIntervalSeconds', 1, MAX_SECONDS],
  ['checkGraceSeconds', 0],
  ['checkTimeoutMinutes', 1, MAX_MINUTES],
  ['agentTimeoutMinutes', 1, MAX_MINUTES],
  ['setupTimeoutMinutes', 1, MAX_MINUTES],
  ['commandTimeoutMinutes', 1, MAX_MINUTES],
  ['logMaxChars', 1],
  ['diffMaxChars', 1],
  ['keepRunDays', 0],
];

const MODEL_ROLES = ['implementer', 'reviewer', 'fixer'] as const;

const LABEL_NAMES = [
  'ready',
  'inProgress',
  'inReview',
  'done',
  'needsHuman',
  'skip',
  'hunt',
] as const;

const FILE_DEFAULTS = {
  ...defaults(),
  models: Object.fromEntries(MODEL_ROLES.map((role) => [role, null])),
};

function configFile(root: string): string {
  return join(root, CONFIG_FILE);
}

function existsAlready(): Error {
  return new Error(`${CONFIG_FILE} exists already. Use --force to replace it.`);
}

export async function writeDefaultConfig(root: string, force: boolean): Promise<string> {
  const path = configFile(root);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeJson(path, FILE_DEFAULTS, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw existsAlready();
    }
    throw error;
  }
  return path;
}

export async function moveOldConfig(root: string, force: boolean): Promise<string | undefined> {
  const old = join(root, OLD_CONFIG_FILE);
  if ((await readTextIfPresent(old)) === undefined) {
    return undefined;
  }
  const path = configFile(root);
  if (!force && (await unlessMissing(() => readFile(path))) !== undefined) {
    throw existsAlready();
  }
  await mkdir(dirname(path), { recursive: true });
  await rename(old, path);
  return path;
}

export async function rejectOldConfig(root: string): Promise<void> {
  if ((await readTextIfPresent(join(root, OLD_CONFIG_FILE))) !== undefined) {
    throw new Error(`${OLD_CONFIG_FILE} moved to ${CONFIG_FILE}. Run next-issue init to move it.`);
  }
}

export async function loadConfig(root: string): Promise<Config> {
  let raw: string | undefined;
  try {
    raw = await readTextIfPresent(configFile(root));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} cannot be read: ${message(error)}`);
  }
  if (raw === undefined) {
    return defaults();
  }
  return parseConfig(
    parseJson(raw, (error) => `${CONFIG_FILE} is not valid JSON: ${message(error)}`),
  );
}

function parseConfig(value: unknown): Config {
  const file = record(value, 'the file');
  if (file.draftPullRequest !== undefined) {
    throw new Error(
      `${CONFIG_FILE}: draftPullRequest is no longer used, because changes land on the base branch with no pull request. Remove the field.`,
    );
  }
  rejectUnknown(file, FIELDS, 'field');
  const config: Config = defaults();
  if (file.remote !== undefined) {
    config.remote = text(file.remote, 'remote', false);
  }
  for (const [field, least, most] of WHOLE_FIELDS) {
    if (file[field] !== undefined) {
      (config[field] as number) = whole(file[field], field, least, most);
    }
  }
  if (file.setupCommand !== undefined) {
    config.setupCommand = text(file.setupCommand, 'setupCommand', false);
  }
  if (file.models !== undefined) {
    config.models = parseModels(file.models);
  }
  if (file.labels !== undefined) {
    config.labels = parseLabels(file.labels, config.labels);
  }
  return config;
}

function parseModels(value: unknown): Config['models'] {
  const models = record(value, 'models');
  rejectUnknown(models, MODEL_ROLES, 'model role');
  const parsed: Config['models'] = {};
  for (const role of MODEL_ROLES) {
    if (models[role] !== undefined && models[role] !== null) {
      parsed[role] = text(models[role], `models.${role}`, false);
    }
  }
  return parsed;
}

function parseLabels(value: unknown, defaultLabels: Config['labels']): Config['labels'] {
  const labels = record(value, 'labels');
  rejectUnknown(labels, LABEL_NAMES, 'label name');
  const parsed = { ...defaultLabels };
  for (const name of LABEL_NAMES) {
    if (labels[name] !== undefined) {
      parsed[name] = text(labels[name], `labels.${name}`, name === 'ready');
    }
  }
  return parsed;
}

export function managedLabels(config: Config): string[] {
  return LABEL_NAMES.filter((name) => name !== 'skip' && name !== 'hunt').map(
    (name) => config.labels[name],
  );
}
