import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONFIG_FILE,
  checkNames,
  OLD_CONFIG_FILE,
  record,
  rejectUnknown,
  text,
  whole,
} from './config-fields.mts';
import { MAX_TIMER_MS } from './durations.mts';
import { hasCode, message, parseJson } from './errors.mts';
import { readTextIfPresent, replaceJson, sortKeys, unlessMissing, writeJson } from './files.mts';
import { isRecord } from './records.mts';

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
  checksTimeoutMinutes: number;
  /** Names of GitHub Actions jobs, check runs and commit statuses that the checks of a landed commit leave out. */
  ignoredChecks: string[];
  models: {
    default?: string;
    implementer?: string;
    reviewer?: string;
    fixer?: string;
    hunter?: string;
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
  checksTimeoutMinutes: 30,
  ignoredChecks: [],
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
  return {
    ...DEFAULTS,
    ignoredChecks: [...DEFAULTS.ignoredChecks],
    models: { ...DEFAULTS.models },
    labels: { ...DEFAULTS.labels },
  };
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
  ['checksTimeoutMinutes', 1, MAX_MINUTES],
];

const MODEL_ROLES = ['default', 'implementer', 'reviewer', 'fixer', 'hunter'] as const;

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
  return new Error(`${CONFIG_FILE} exists already. Use \`--force\` to replace it.`);
}

export async function writeDefaultConfig(
  root: string,
  force: boolean,
): Promise<{ path: string; written: boolean }> {
  const path = configFile(root);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeJson(path, FILE_DEFAULTS, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      return { path, written: false };
    }
    throw error;
  }
  return { path, written: true };
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
    throw new Error(
      `${OLD_CONFIG_FILE} moved to ${CONFIG_FILE}. Run \`npx -y next-issue@latest init\` to move it.`,
    );
  }
}

export async function loadConfig(
  root: string,
  options: { sortFile?: boolean } = {},
): Promise<Config> {
  let raw: string | undefined;
  try {
    raw = await readTextIfPresent(configFile(root));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} cannot be read: ${message(error)}`);
  }
  if (raw === undefined) {
    return defaults();
  }
  const file = parseJson(raw, (error) => `${CONFIG_FILE} is not valid JSON: ${message(error)}`);
  const config = parseConfig(file);
  if (options.sortFile === true) {
    await sortConfigFile(root, file as Record<string, unknown>);
  }
  return config;
}

export async function removeUnknownFields(root: string): Promise<string[]> {
  const path = configFile(root);
  const raw = await readTextIfPresent(path);
  const file = raw === undefined ? undefined : parsedOrUndefined(raw);
  if (!isObject(file)) {
    return [];
  }
  const removed = [
    ...removeUnknown(file, FIELDS, ''),
    ...removeUnknown(file.models, MODEL_ROLES, 'models.'),
    ...removeUnknown(file.labels, LABEL_NAMES, 'labels.'),
  ];
  if (removed.length > 0) {
    await replaceJson(path, file);
  }
  return removed;
}

function parsedOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function removeUnknown(value: unknown, known: readonly string[], prefix: string): string[] {
  if (!isObject(value)) {
    return [];
  }
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  for (const key of unknown) {
    delete value[key];
  }
  return unknown.map((key) => `${prefix}${key}`);
}

async function sortConfigFile(root: string, file: Record<string, unknown>): Promise<void> {
  const sorted = sortKeys({
    ...file,
    ...(Array.isArray(file.ignoredChecks) && { ignoredChecks: [...file.ignoredChecks].sort() }),
  });
  if (JSON.stringify(sorted) !== JSON.stringify(file)) {
    await replaceJson(configFile(root), sorted);
  }
}

function parseConfig(value: unknown): Config {
  const file = record(value, 'the file');
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
  if (file.ignoredChecks !== undefined) {
    config.ignoredChecks = checkNames(file.ignoredChecks, 'ignoredChecks');
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
      parsed[name] = labelName(labels[name], `labels.${name}`, name === 'ready');
    }
  }
  rejectSameLabels(parsed);
  return parsed;
}

function labelName(value: unknown, field: string, allowEmpty: boolean): string {
  const name = text(value, field, allowEmpty);
  if (/[,"]/.test(name)) {
    throw new Error(`${CONFIG_FILE}: ${field} must not contain a comma or a double quote.`);
  }
  return name;
}

// Label checks ignore case, so two status labels that match without case would
// make the harness read one status as another.
function rejectSameLabels(labels: Config['labels']): void {
  const seen = new Map<string, string>();
  for (const name of LABEL_NAMES) {
    if (labels[name] === '') {
      continue;
    }
    const key = labels[name].toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      throw new Error(
        `${CONFIG_FILE}: labels.${other} and labels.${name} must be different labels, but both are ${labels[name]} when case is ignored.`,
      );
    }
    seen.set(key, name);
  }
}

export function managedLabels(config: Config): string[] {
  return LABEL_NAMES.filter((name) => name !== 'skip' && name !== 'hunt').map(
    (name) => config.labels[name],
  );
}
