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

export type Kind = "issue" | "pr";

export type CheckState = "pass" | "fail" | "pending" | "none" | "timeout";

const CHECK_PENDING_CODE = 8;
const KNOWN_LABELS = new Map<string, Set<string>>();
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
    "--search",
    "sort:created-asc",
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

export async function labelsOf(repo: Repo, kind: Kind, number: number): Promise<string[]> {
  const raw = await gh(repo, [kind, "view", String(number), "--json", "labels"]);
  const parsed = JSON.parse(raw) as { labels: Array<{ name: string }> };
  return parsed.labels.map((label) => label.name);
}

export function labelArgs(add: string, remove: string[], current: string[]): string[] {
  const args = ["--add-label", add];
  for (const name of remove.filter((item) => item !== add && current.includes(item))) {
    args.push("--remove-label", name);
  }
  return args;
}

export async function setLabel(
  repo: Repo,
  kind: Kind,
  number: number,
  add: string,
  remove: string[],
): Promise<void> {
  await ensureLabel(repo, add);
  const current = await labelsOf(repo, kind, number);
  await gh(repo, [kind, "edit", String(number), ...labelArgs(add, remove, current)]);
}

export async function ensureLabel(repo: Repo, label: string): Promise<void> {
  let known = KNOWN_LABELS.get(slug(repo));
  if (known === undefined) {
    const raw = await gh(repo, ["label", "list", "--limit", "1000", "--json", "name"]);
    known = new Set((JSON.parse(raw) as Array<{ name: string }>).map((item) => item.name));
    KNOWN_LABELS.set(slug(repo), known);
  }
  if (known.has(label)) {
    return;
  }
  await run("gh", ["label", "create", label, "--repo", slug(repo)], { cwd: repo.root });
  known.add(label);
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
  draft: boolean,
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
    ...(draft ? ["--draft"] : []),
  ]);
  const number = await findPr(repo, branch);
  if (number === undefined) {
    throw new Error(`The pull request for ${branch} was not found after creation.`);
  }
  return number;
}

async function prHead(repo: Repo, branch: string): Promise<string> {
  return gh(repo, ["pr", "view", branch, "--json", "headRefOid", "--jq", ".headRefOid"]);
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

async function watchOnce(
  repo: Repo,
  branch: string,
  intervalSeconds: number,
  timeoutMs: number,
  inherit: boolean,
): Promise<CheckState> {
  const watch = await run(
    "gh",
    ["pr", "checks", branch, "--watch", "--fail-fast", "--interval", String(intervalSeconds), "--repo", slug(repo)],
    { cwd: repo.root, inherit, timeoutMs },
  );
  if (watch.timedOut) {
    return "timeout";
  }
  if (watch.code === 0) {
    return "pass";
  }
  if (watch.code === CHECK_PENDING_CODE) {
    return "pending";
  }
  return "fail";
}

export type ChecksProbe = {
  head: () => Promise<string>;
  list: () => Promise<"none" | "some">;
  watch: (timeoutMs: number) => Promise<CheckState>;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type PollOptions = {
  intervalSeconds: number;
  graceMs: number;
  timeoutMs: number;
  head?: string;
};

export type WaitOptions = PollOptions & { inherit: boolean };

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function pollChecks(
  probe: ChecksProbe,
  options: PollOptions,
  clock: Clock = REAL_CLOCK,
): Promise<CheckState> {
  const deadline = clock.now() + options.timeoutMs;
  const rest = (): number => Math.max(0, deadline - clock.now());
  let shown: number | undefined;
  for (;;) {
    if (rest() === 0) {
      return "timeout";
    }
    if (options.head === undefined || (await probe.head()) === options.head) {
      shown ??= clock.now();
      if ((await probe.list()) === "none") {
        if (clock.now() - shown >= options.graceMs) {
          return "none";
        }
      } else {
        const state = await probe.watch(rest());
        if (state !== "pending") {
          return state;
        }
      }
    }
    await clock.sleep(Math.min(options.intervalSeconds * 1000, rest()));
  }
}

export function waitForChecks(repo: Repo, branch: string, options: WaitOptions): Promise<CheckState> {
  return pollChecks(
    {
      head: () => prHead(repo, branch),
      list: async () => ((await readChecks(repo, branch)) === "none" ? "none" : "some"),
      watch: (timeoutMs) =>
        watchOnce(repo, branch, options.intervalSeconds, timeoutMs, options.inherit),
    },
    options,
  );
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
      tailChars: maxChars,
    });
    parts.push(logs.stdout.slice(-maxChars));
  }
  return parts.join("\n\n").slice(-maxChars);
}

export async function markPrReady(repo: Repo, pr: number): Promise<boolean> {
  const result = await run("gh", ["pr", "ready", String(pr), "--repo", slug(repo)], {
    cwd: repo.root,
  });
  return result.code === 0;
}

export async function commentOnPr(repo: Repo, pr: number, body: string): Promise<void> {
  await gh(repo, ["pr", "comment", String(pr), "--body-file", "-"], body);
}
