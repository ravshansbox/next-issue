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
  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${message(error)}`);
  }
  return {
    ...DEFAULTS,
    ...parsed,
    models: { ...DEFAULTS.models, ...parsed.models },
    labels: { ...DEFAULTS.labels, ...parsed.labels },
  };
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
