import { must, run } from "./exec.mts";
import type { Repo } from "./git.mts";

export type Issue = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
};

export type CheckState = "pass" | "fail" | "pending" | "none" | "timeout";

const CHECK_PENDING_CODE = 8;
const NO_CHECKS = /no checks reported/i;

type CheckSummary = { name: string; bucket: string; link: string; description: string };

function slug(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

async function gh(repo: Repo, args: string[], input?: string): Promise<string> {
  return must("gh", [...args, "--repo", slug(repo)], { cwd: repo.root, input });
}

export async function defaultBranch(repo: Repo): Promise<string> {
  const raw = await must("gh", ["repo", "view", slug(repo), "--json", "defaultBranchRef"], {
    cwd: repo.root,
  });
  return JSON.parse(raw).defaultBranchRef.name as string;
}

export async function currentLogin(repo: Repo): Promise<string> {
  return must("gh", ["api", "user", "--jq", ".login"], { cwd: repo.root });
}

export async function openIssues(repo: Repo, limit: number): Promise<Issue[]> {
  const raw = await gh(repo, [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,body,createdAt,labels,assignees",
  ]);
  const parsed = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    body: string | null;
    createdAt: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
  }>;
  return parsed
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      createdAt: item.createdAt,
      labels: item.labels.map((label) => label.name),
      assignees: item.assignees.map((assignee) => assignee.login),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function issueComments(repo: Repo, issue: number): Promise<string[]> {
  const raw = await gh(repo, ["issue", "view", String(issue), "--json", "comments"]);
  const parsed = JSON.parse(raw) as { comments: Array<{ author: { login: string }; body: string }> };
  return parsed.comments.map((comment) => `@${comment.author.login}: ${comment.body}`);
}

export async function assignIssue(repo: Repo, issue: number, login: string): Promise<void> {
  await gh(repo, ["issue", "edit", String(issue), "--add-assignee", login]);
}

export async function labelsOf(repo: Repo, issue: number): Promise<string[]> {
  const raw = await gh(repo, ["issue", "view", String(issue), "--json", "labels"]);
  const parsed = JSON.parse(raw) as { labels: Array<{ name: string }> };
  return parsed.labels.map((label) => label.name);
}

export async function setLabel(repo: Repo, issue: number, add: string, remove: string[]): Promise<void> {
  await ensureLabel(repo, add);
  const current = await labelsOf(repo, issue);
  const args = ["issue", "edit", String(issue), "--add-label", add];
  for (const name of remove.filter((item) => item !== add && current.includes(item))) {
    args.push("--remove-label", name);
  }
  await gh(repo, args);
}

export async function ensureLabel(repo: Repo, label: string): Promise<void> {
  await run("gh", ["label", "create", label, "--repo", slug(repo)], { cwd: repo.root });
}

export async function findPr(repo: Repo, branch: string): Promise<number | undefined> {
  const result = await run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--repo", slug(repo)],
    { cwd: repo.root },
  );
  if (result.code !== 0) {
    return undefined;
  }
  const parsed = JSON.parse(result.stdout) as Array<{ number: number }>;
  return parsed[0]?.number;
}

export async function createPr(
  repo: Repo,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<number> {
  await gh(repo, [
    "pr",
    "create",
    "--head",
    branch,
    "--base",
    base,
    "--title",
    title,
    "--body",
    body,
  ]);
  const number = await findPr(repo, branch);
  if (number === undefined) {
    throw new Error(`The pull request for ${branch} was not found after creation.`);
  }
  return number;
}

async function readChecks(repo: Repo, branch: string): Promise<CheckSummary[] | "none"> {
  const result = await run(
    "gh",
    ["pr", "checks", branch, "--json", "name,bucket,link,description", "--repo", slug(repo)],
    { cwd: repo.root },
  );
  const output = result.stdout.trim();
  if (output.length === 0) {
    if (NO_CHECKS.test(result.stderr)) {
      return "none";
    }
    throw new Error(
      `gh pr checks ${branch} failed with code ${result.code}: ${result.stderr.trim()}`,
    );
  }
  const checks = JSON.parse(output) as CheckSummary[];
  return checks.length === 0 ? "none" : checks;
}

async function watchOnce(repo: Repo, branch: string, intervalSeconds: number): Promise<CheckState> {
  const watch = await run(
    "gh",
    ["pr", "checks", branch, "--watch", "--fail-fast", "--interval", String(intervalSeconds), "--repo", slug(repo)],
    { cwd: repo.root, inherit: true },
  );
  if (watch.code === 0) {
    return "pass";
  }
  if (watch.code === CHECK_PENDING_CODE) {
    return "pending";
  }
  return "fail";
}

export async function waitForChecks(
  repo: Repo,
  branch: string,
  intervalSeconds: number,
  timeoutMs: number,
): Promise<CheckState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readChecks(repo, branch)) === "none") {
      return "none";
    }
    const state = await watchOnce(repo, branch, intervalSeconds);
    if (state !== "pending") {
      return state;
    }
    await delay(intervalSeconds * 1000);
  }
  return "timeout";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function failedCheckLogs(repo: Repo, branch: string, maxChars: number): Promise<string> {
  const checks = await readChecks(repo, branch);
  if (checks === "none") {
    return "The checks failed, but gh reports no check for the branch.";
  }
  const failed = checks.filter((check) => check.bucket === "fail");
  const parts: string[] = [];
  for (const check of failed) {
    parts.push(`## ${check.name}\n${check.description}`);
    const runId = /\/actions\/runs\/(\d+)/.exec(check.link)?.[1];
    if (runId === undefined) {
      continue;
    }
    const logs = await run("gh", ["run", "view", runId, "--log-failed", "--repo", slug(repo)], {
      cwd: repo.root,
    });
    parts.push(logs.stdout.slice(-maxChars));
  }
  return parts.join("\n\n").slice(-maxChars);
}

export async function commentOnPr(repo: Repo, pr: number, body: string): Promise<void> {
  await gh(repo, ["pr", "comment", String(pr), "--body-file", "-"], body);
}
