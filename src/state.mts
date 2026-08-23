import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "./git.mts";

export type Phase = "claimed" | "implemented" | "pushed" | "review" | "done" | "needs-human";

export type IssueState = {
  issue: number;
  phase: Phase;
  branch: string;
  pr?: number;
  cycle: number;
};

function dir(repo: Repo): string {
  return join(repo.root, ".next-issue");
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

export async function writeState(repo: Repo, state: IssueState): Promise<void> {
  await mkdir(dir(repo), { recursive: true });
  await writeFile(file(repo, state.issue), `${JSON.stringify(state, null, 2)}\n`);
}
