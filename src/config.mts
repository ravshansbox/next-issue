import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Config = {
  remote: string;
  issueLimit: number;
  maxCiFixes: number;
  maxReviewRounds: number;
  checkIntervalSeconds: number;
  checkTimeoutMinutes: number;
  logMaxChars: number;
  setupCommand?: string;
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
  labels: {
    ready: "status:todo",
    inProgress: "status:in-progress",
    inReview: "status:in-review",
    done: "status:done",
    needsHuman: "status:needs-human",
    skip: "status:blocked",
  },
};

export async function loadConfig(cwd: string): Promise<Config> {
  try {
    const raw = await readFile(join(cwd, "next-issue.config.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      ...DEFAULTS,
      ...parsed,
      labels: { ...DEFAULTS.labels, ...parsed.labels },
    };
  } catch {
    return DEFAULTS;
  }
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
