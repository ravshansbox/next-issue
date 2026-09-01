import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { message } from "./observe.mts";

export type Config = {
  remote: string;
  issueLimit: number;
  maxCiFixes: number;
  maxReviewRounds: number;
  checkIntervalSeconds: number;
  checkTimeoutMinutes: number;
  logMaxChars: number;
  diffMaxChars: number;
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
  remote: "origin",
  issueLimit: 100,
  maxCiFixes: 3,
  maxReviewRounds: 3,
  checkIntervalSeconds: 15,
  checkTimeoutMinutes: 60,
  logMaxChars: 20000,
  diffMaxChars: 60000,
  draftPullRequest: true,
  models: {},
  labels: {
    ready: "status:todo",
    inProgress: "status:in-progress",
    inReview: "status:in-review",
    done: "status:done",
    needsHuman: "status:needs-human",
    skip: "status:blocked",
  },
};

const FIELDS: string[] = [...Object.keys(DEFAULTS), "setupCommand"];

const WHOLE_FIELDS: Array<[keyof Config, number]> = [
  ["issueLimit", 1],
  ["maxCiFixes", 0],
  ["maxReviewRounds", 1],
  ["checkIntervalSeconds", 1],
  ["checkTimeoutMinutes", 1],
  ["logMaxChars", 1],
  ["diffMaxChars", 1],
];

const MODEL_ROLES = ["implementer", "reviewer", "fixer"] as const;

const LABEL_NAMES = ["ready", "inProgress", "inReview", "done", "needsHuman", "skip"] as const;

export const CONFIG_FILE = "next-issue.config.json";

export async function writeDefaultConfig(root: string, force: boolean): Promise<string> {
  const path = join(root, CONFIG_FILE);
  try {
    await writeFile(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${CONFIG_FILE} exists already. Use --force to replace it.`);
    }
    throw error;
  }
  return path;
}

export async function loadConfig(root: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch {
    return DEFAULTS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${message(error)}`);
  }
  return parseConfig(parsed);
}

export function parseConfig(value: unknown): Config {
  const file = record(value, "the file");
  for (const key of Object.keys(file)) {
    if (!FIELDS.includes(key)) {
      throw new Error(`${CONFIG_FILE} holds an unknown field: ${key}`);
    }
  }
  const config: Config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models },
    labels: { ...DEFAULTS.labels },
  };
  if (file.remote !== undefined) {
    config.remote = text(file.remote, "remote", false);
  }
  for (const [field, least] of WHOLE_FIELDS) {
    if (file[field] !== undefined) {
      (config[field] as number) = whole(file[field], field, least);
    }
  }
  if (file.draftPullRequest !== undefined) {
    if (typeof file.draftPullRequest !== "boolean") {
      throw new Error(`${CONFIG_FILE}: draftPullRequest must be true or false.`);
    }
    config.draftPullRequest = file.draftPullRequest;
  }
  if (file.setupCommand !== undefined) {
    config.setupCommand = text(file.setupCommand, "setupCommand", false);
  }
  if (file.models !== undefined) {
    const models = record(file.models, "models");
    for (const key of Object.keys(models)) {
      if (!MODEL_ROLES.includes(key as (typeof MODEL_ROLES)[number])) {
        throw new Error(`${CONFIG_FILE} holds an unknown model role: ${key}`);
      }
    }
    for (const role of MODEL_ROLES) {
      if (models[role] !== undefined) {
        config.models[role] = text(models[role], `models.${role}`, false);
      }
    }
  }
  if (file.labels !== undefined) {
    const labels = record(file.labels, "labels");
    for (const key of Object.keys(labels)) {
      if (!LABEL_NAMES.includes(key as (typeof LABEL_NAMES)[number])) {
        throw new Error(`${CONFIG_FILE} holds an unknown label name: ${key}`);
      }
    }
    for (const name of LABEL_NAMES) {
      if (labels[name] !== undefined) {
        config.labels[name] = text(labels[name], `labels.${name}`, name === "ready");
      }
    }
  }
  return config;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE}: ${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function whole(value: unknown, field: string, least: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least) {
    throw new Error(`${CONFIG_FILE}: ${field} must be a whole number of ${least} or more.`);
  }
  return value;
}

function text(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${CONFIG_FILE}: ${field} must be ${allowEmpty ? "text" : "text that is not empty"}.`,
    );
  }
  return value;
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
