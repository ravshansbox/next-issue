import { join } from 'node:path';
import type { PollOptions } from './check-poll.mts';
import { CONFIG_FILE, flag, record, rejectUnknown, text, whole } from './config-fields.mts';
import { minutesToMs, secondsToMs } from './durations.mts';
import { hasCode, message } from './errors.mts';
import { readTextIfPresent, writeJson } from './files.mts';
import type { Polling } from './poll.mts';

export type Config = {
  remote: string;
  issueLimit: number;
  concurrency: number;
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
  draftPullRequest: boolean;
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
  };
};

const DEFAULTS: Config = {
  remote: 'origin',
  issueLimit: 100,
  concurrency: 1,
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
  draftPullRequest: true,
  models: {},
  labels: {
    ready: 'status:todo',
    inProgress: 'status:in-progress',
    inReview: 'status:in-review',
    done: 'status:done',
    needsHuman: 'status:needs-human',
    skip: 'status:blocked',
  },
};

function defaults(): Config {
  return { ...DEFAULTS, models: { ...DEFAULTS.models }, labels: { ...DEFAULTS.labels } };
}

const FIELDS: string[] = [...Object.keys(DEFAULTS), 'setupCommand'];

const WHOLE_FIELDS: Array<[keyof Config, number]> = [
  ['issueLimit', 1],
  ['concurrency', 1],
  ['maxCiFixes', 0],
  ['maxCommitFixes', 0],
  ['maxReviewRounds', 1],
  ['checkIntervalSeconds', 1],
  ['checkGraceSeconds', 0],
  ['checkTimeoutMinutes', 1],
  ['agentTimeoutMinutes', 1],
  ['setupTimeoutMinutes', 1],
  ['commandTimeoutMinutes', 1],
  ['logMaxChars', 1],
  ['diffMaxChars', 1],
  ['keepRunDays', 0],
];

const MODEL_ROLES = ['implementer', 'reviewer', 'fixer'] as const;

const LABEL_NAMES = ['ready', 'inProgress', 'inReview', 'done', 'needsHuman', 'skip'] as const;

const FILE_DEFAULTS = {
  ...defaults(),
  models: Object.fromEntries(MODEL_ROLES.map((role) => [role, null])),
};

function configFile(root: string): string {
  return join(root, CONFIG_FILE);
}

export async function writeDefaultConfig(root: string, force: boolean): Promise<string> {
  const path = configFile(root);
  try {
    await writeJson(path, FILE_DEFAULTS, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new Error(`${CONFIG_FILE} exists already. Use --force to replace it.`);
    }
    throw error;
  }
  return path;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${message(error)}`);
  }
  return parseConfig(parsed);
}

function parseConfig(value: unknown): Config {
  const file = record(value, 'the file');
  rejectUnknown(file, FIELDS, 'field');
  const config: Config = defaults();
  if (file.remote !== undefined) {
    config.remote = text(file.remote, 'remote', false);
  }
  for (const [field, least] of WHOLE_FIELDS) {
    if (file[field] !== undefined) {
      (config[field] as number) = whole(file[field], field, least);
    }
  }
  if (file.draftPullRequest !== undefined) {
    config.draftPullRequest = flag(file.draftPullRequest, 'draftPullRequest');
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
  return [
    config.labels.ready,
    config.labels.inProgress,
    config.labels.inReview,
    config.labels.done,
    config.labels.needsHuman,
  ];
}

export function checkPolling(config: Config): Polling {
  return {
    intervalSeconds: config.checkIntervalSeconds,
    timeoutMs: minutesToMs(config.checkTimeoutMinutes),
  };
}

export function checkWaiting(config: Config, grace: boolean): PollOptions {
  return {
    ...checkPolling(config),
    graceMs: grace ? secondsToMs(config.checkGraceSeconds) : 0,
  };
}
