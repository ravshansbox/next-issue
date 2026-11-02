import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "./git.mts";

export const STATE_DIR = ".next-issue";

export type Phase = "claimed" | "implemented" | "review";

export type IssueState = {
  issue: number;
  phase: Phase;
  branch: string;
  pr?: number;
  title?: string;
  ciFixes: number;
  commitFixes?: number;
  baseFix?: BaseFix;
  reviewRounds: number;
  reviewLog: ReviewRound[];
};

export type BaseFix = {
  sha: string;
  head: string;
};

export type ReviewRound = {
  round: number;
  fingerprint: string;
  findings: string;
  dispute?: string;
};

function dir(repo: Repo): string {
  return join(repo.root, STATE_DIR);
}

function file(repo: Repo, issue: number): string {
  return join(dir(repo), `${issue}.json`);
}

export async function readState(repo: Repo, issue: number): Promise<IssueState | undefined> {
  const path = file(repo, issue);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the state file ${path} is not valid JSON`);
  }
  if (!isState(parsed)) {
    throw new Error(`the state file ${path} does not hold a valid state`);
  }
  return parsed;
}

function isState(value: unknown): value is IssueState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    typeof state.issue === "number" &&
    typeof state.phase === "string" &&
    typeof state.branch === "string" &&
    typeof state.ciFixes === "number" &&
    typeof state.reviewRounds === "number" &&
    Array.isArray(state.reviewLog)
  );
}

export async function savedIssues(repo: Repo): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir(repo));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(\d+)\.json$/.exec(name);
    return match === null ? [] : [Number(match[1])];
  });
}

export function resetState(state: IssueState): IssueState {
  return { ...state, ciFixes: 0, commitFixes: 0, reviewRounds: 0, reviewLog: [] };
}

export async function writeState(repo: Repo, state: IssueState): Promise<void> {
  await mkdir(dir(repo), { recursive: true });
  await writeFile(file(repo, state.issue), `${JSON.stringify(state, null, 2)}\n`);
}

export async function dropState(repo: Repo, issue: number): Promise<void> {
  await rm(file(repo, issue), { force: true });
}
