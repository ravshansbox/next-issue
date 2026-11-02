import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  reviewRounds: number;
  reviewLog: ReviewRound[];
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
  try {
    return JSON.parse(text) as IssueState;
  } catch {
    throw new Error(`the state file ${path} is not valid JSON`);
  }
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
