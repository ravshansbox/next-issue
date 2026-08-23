import { basename, dirname, join } from "node:path";
import { must, run } from "./exec.mts";

export type Repo = {
  owner: string;
  name: string;
  root: string;
};

const REMOTE_PATTERNS = [
  /^git@[^:]+:(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^ssh:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^https?:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
];

export function parseRemote(url: string): { owner: string; name: string } {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (match?.groups) {
      return { owner: match.groups.owner!, name: match.groups.name! };
    }
  }
  throw new Error(`Cannot parse the git remote URL: ${url}`);
}

export async function detectRepo(cwd: string, remote: string): Promise<Repo> {
  const root = await must("git", ["rev-parse", "--show-toplevel"], { cwd });
  const url = await must("git", ["remote", "get-url", remote], { cwd });
  const { owner, name } = parseRemote(url);
  return { owner, name, root };
}

export function worktreePath(repo: Repo, issue: number): string {
  return join(dirname(repo.root), `${basename(repo.root)}-issue-${issue}`);
}

export async function addWorktree(repo: Repo, issue: number, base: string, remote: string): Promise<string> {
  const path = worktreePath(repo, issue);
  const branch = branchName(issue);
  await must("git", ["fetch", remote, base], { cwd: repo.root });
  const existing = await run("git", ["rev-parse", "--verify", branch], { cwd: repo.root });
  const args =
    existing.code === 0
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, `${remote}/${base}`];
  await must("git", args, { cwd: repo.root });
  return path;
}

export async function removeWorktree(repo: Repo, issue: number): Promise<void> {
  await run("git", ["worktree", "remove", worktreePath(repo, issue)], { cwd: repo.root });
}

export function branchName(issue: number): string {
  return `issue-${issue}`;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await must("git", ["status", "--porcelain"], { cwd });
  return status.length > 0;
}

export async function diff(cwd: string, base: string, remote: string): Promise<string> {
  return must("git", ["diff", `${remote}/${base}...HEAD`], { cwd });
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await must("git", ["add", "-A"], { cwd });
  await must("git", ["commit", "-m", message], { cwd });
  return true;
}

export async function push(cwd: string, remote: string, branch: string): Promise<void> {
  await must("git", ["push", "-u", remote, branch], { cwd });
}
