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
  handedOver?: boolean;
  ciFixes: number;
  reviewRounds: number;
  reviewLog: ReviewRound[];
};

export type ReviewRound = {
  round: number;
  fingerprint: string;
  findings: string;
};

function dir(repo: Repo): string {
  return join(repo.root, STATE_DIR);
}

function file(repo: Repo, issue: number): string {
  return join(dir(repo), `${issue}.json`);
}

export async function readState(repo: Repo, issue: number): Promise<IssueState | undefined> {
  try {
    return JSON.parse(await readFile(file(repo, issue), "utf8")) as IssueState;
  } catch {
    return undefined;
  }
}

export async function resetState(repo: Repo, issue: number): Promise<boolean> {
  const state = await readState(repo, issue);
  if (state === undefined) {
    return false;
  }
  const next: IssueState = { ...state, ciFixes: 0, reviewRounds: 0, reviewLog: [] };
  delete next.handedOver;
  await writeState(repo, next);
  return true;
}

export async function writeState(repo: Repo, state: IssueState): Promise<void> {
  await mkdir(dir(repo), { recursive: true });
  await writeFile(file(repo, state.issue), `${JSON.stringify(state, null, 2)}\n`);
}

export async function takeStop(repo: Repo): Promise<boolean> {
  try {
    await rm(join(dir(repo), "stop"));
    return true;
  } catch {
    return false;
  }
}

export async function dropState(repo: Repo, issue: number): Promise<void> {
  await rm(file(repo, issue), { force: true });
}
