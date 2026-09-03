import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentRequest, AgentResult } from "../src/agents.mts";
import { type Config, loadConfig } from "../src/config.mts";
import type { CheckState, Issue, WaitOptions } from "../src/github.mts";
import { Recorder } from "../src/observe.mts";
import { type Context, type IssueReport, type Ports, processIssue } from "../src/pipeline.mts";
import { type IssueState, readState, writeState } from "../src/state.mts";
import type { Verdict } from "../src/verdict.mts";

const ISSUE: Issue = {
  number: 7,
  title: "Add a flag",
  body: "Please add it.",
  createdAt: "2026-01-01T00:00:00Z",
  labels: ["status:todo"],
  assignees: [],
};

const APPROVE: Verdict = { verdict: "approve", summary: "Good.", findings: [] };

function changes(...details: string[]): Verdict {
  return {
    verdict: "request_changes",
    summary: "Please fix.",
    findings: details.map((detail) => ({ severity: "blocking" as const, detail })),
  };
}

function result(text: string, structured?: unknown): AgentResult {
  return {
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 1,
    toolCalls: 0,
    ms: 1,
    costUsd: 0,
    structured,
  };
}

type Plan = {
  config?: Partial<Config>;
  checks?: CheckState[];
  verdicts?: Verdict[];
  commits?: boolean[];
  diff?: string;
  setupCode?: number;
  setupTimedOut?: boolean;
  selfCommit?: boolean;
  fail?: keyof Ports;
  fixerText?: string;
  saved?: IssueState;
  issue?: Issue;
};

type Harness = {
  context: Context;
  labels: Array<{ kind: string; number: number; label: string }>;
  prompts: Array<{ role: string; prompt: string }>;
  comments: string[];
  checkReads: number;
  waits: WaitOptions[];
  pushes: number;
  ready: number[];
  deleted: string[];
  run: () => Promise<IssueReport>;
  state: () => Promise<IssueState | undefined>;
};

async function harness(t: TestContext, plan: Plan = {}): Promise<Harness> {
  t.mock.method(process.stderr, "write", () => true);
  const root = await mkdtemp(join(tmpdir(), "next-issue-"));
  const repo = { owner: "acme", name: "tool", root };
  const config = { ...(await loadConfig(root)), ...plan.config };
  const issue = plan.issue ?? ISSUE;
  if (plan.saved !== undefined) {
    await writeState(repo, plan.saved);
  }

  const checks = [...(plan.checks ?? ["pass"])];
  const verdicts = [...(plan.verdicts ?? [APPROVE])];
  const commits = [...(plan.commits ?? [])];
  let head = 0;
  const state: Harness = {
    context: undefined as unknown as Context,
    labels: [],
    prompts: [],
    comments: [],
    checkReads: 0,
    waits: [],
    pushes: 0,
    ready: [],
    deleted: [],
    run: () => processIssue(state.context, issue),
    state: () => readState(repo, issue.number),
  };

  const ports: Ports = {
    addWorktree: async () => join(root, "worktree"),
    assignIssue: async () => undefined,
    commentOnPr: async (_repo, _pr, body) => {
      state.comments.push(body);
    },
    commitAll: async () => {
      const committed = commits.shift() ?? true;
      if (committed) {
        head += 1;
      }
      return committed;
    },
    createPr: async () => 101,
    deleteBranch: async (_repo, branch) => {
      state.deleted.push(branch);
      return true;
    },
    diff: async () => plan.diff ?? "the diff",
    failedCheckLogs: async () => "the failed job logs",
    findPr: async () => undefined,
    hasWorktree: async () => false,
    issueComments: async () => [],
    markPrReady: async (_repo, pr) => {
      state.ready.push(pr);
      return true;
    },
    push: async () => {
      state.pushes += 1;
    },
    removeWorktree: async () => true,
    revision: async () => String(head),
    runAgent: async (_recorder, request: AgentRequest) => {
      state.prompts.push({ role: request.name, prompt: request.prompt });
      if (request.name === "reviewer") {
        return result("reviewed", verdicts.shift());
      }
      if (request.name === "fixer" && plan.fixerText !== undefined) {
        return result(plan.fixerText);
      }
      if (plan.selfCommit === true) {
        head += 1;
      }
      return result(`commit: fix: work on #${issue.number}`);
    },
    runSetup: async () => ({ code: plan.setupCode ?? 0, stderr: "", timedOut: plan.setupTimedOut }),
    setLabel: async (_repo, kind, number, label) => {
      state.labels.push({ kind, number, label });
    },
    waitForChecks: async (_repo, _branch, options) => {
      state.waits.push(options);
      const next = checks[Math.min(state.checkReads, checks.length - 1)]!;
      state.checkReads += 1;
      return next;
    },
  };
  if (plan.fail !== undefined) {
    (ports[plan.fail] as unknown) = async () => {
      throw new Error("the port broke");
    };
  }

  const recorder = await Recorder.create(root, "quiet");
  t.after(() => recorder.close());
  state.context = { repo, config, base: "main", login: "me", recorder, ports };
  return state;
}

function roles(target: Harness): string[] {
  return target.prompts.map((entry) => entry.role);
}

test("a clean run implements, reviews and finishes", async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, "done");
  assert.equal(report.reason, undefined);
  assert.equal(report.pr, 101);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ["implementer", "reviewer"]);
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, [101]);
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ["issue-7"]);
  assert.match(target.comments[0]!, /Review: approved/);
});

test("the status labels go to the issue and to the pull request", async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.labels, [
    { kind: "issue", number: 7, label: "status:in-progress" },
    { kind: "issue", number: 7, label: "status:in-review" },
    { kind: "pr", number: 101, label: "status:in-review" },
    { kind: "issue", number: 7, label: "status:done" },
    { kind: "pr", number: 101, label: "status:done" },
  ]);
});

test("a failed build gives the logs to the fixer and then reviews", async (t) => {
  const target = await harness(t, { checks: ["fail", "pass"] });
  const report = await target.run();
  assert.equal(report.outcome, "done");
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ["implementer", "fixer", "reviewer"]);
  assert.match(target.prompts[1]!.prompt, /the failed job logs/);
  assert.equal(target.pushes, 2);
});

test("a build that fails after the approval keeps the issue open", async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ["pass", "fail"] });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "check budget");
  assert.deepEqual(target.ready, []);
  assert.equal(
    target.labels.some((entry) => entry.label === "status:done"),
    false,
  );
});

test("a build that fails after the approval starts a fix round", async (t) => {
  const target = await harness(t, { checks: ["pass", "fail", "pass"], verdicts: [APPROVE, APPROVE] });
  const report = await target.run();
  assert.equal(report.outcome, "done");
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ["implementer", "reviewer", "fixer", "reviewer"]);
  assert.deepEqual(target.ready, [101]);
});

test("a fixer that reports an unrelated failure hands over without a commit", async (t) => {
  const target = await harness(t, {
    checks: ["fail"],
    fixerText: "unrelated: product-inventories fails on main too, the diff does not touch it",
  });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "unrelated failure");
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, []);
  assert.match(target.comments.at(-1)!, /a reason this change did not cause: product-inventories fails on main too/);
});

test("the fixer may only plead unrelated about the checks", async (t) => {
  const target = await harness(t, {
    verdicts: [changes("The count is wrong.")],
    fixerText: "unrelated: not my problem",
  });
  const report = await target.run();
  assert.equal(report.reason, "no fix commit");
  assert.doesNotMatch(target.prompts.at(-1)!.prompt, /unrelated: /);
});

test("the check budget hands the issue to a person", async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 1 }, checks: ["fail", "fail"] });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "check budget");
  assert.equal(report.ciFixes, 1);
  assert.equal(target.labels.at(-1)?.label, "status:needs-human");
  assert.match(target.comments.at(-1)!, /needs help: The limit of 1 check fixes/);
  assert.equal((await target.state())?.handedOver, true);
  assert.equal((await target.state())?.phase, "review");
});

test("a check budget of zero stops before the first fix", async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ["fail"] });
  const report = await target.run();
  assert.equal(report.reason, "check budget");
  assert.deepEqual(roles(target), ["implementer"]);
});

test("the review budget hands the issue to a person", async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 1 },
    verdicts: [changes("The count is wrong.")],
  });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "review budget");
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ["implementer", "reviewer", "fixer"]);
});

test("a repeated finding set stops the ping-pong", async (t) => {
  const target = await harness(t, {
    verdicts: [changes("The count is wrong."), changes("the  count is wrong")],
  });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "repeated findings");
  assert.equal(report.reviewRounds, 2);
});

test("the fixer sees the findings once in the first round and the history later", async (t) => {
  const target = await harness(t, {
    verdicts: [changes("The count is wrong."), changes("The name is wrong."), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, "done");
  const first = target.prompts.find((entry) => entry.role === "fixer")!.prompt;
  assert.match(first, /The count is wrong\./);
  assert.doesNotMatch(first, /Earlier rounds/);
  const second = target.prompts.filter((entry) => entry.role === "fixer")[1]!.prompt;
  assert.match(second, /## Earlier rounds\nRound 1:\n- The count is wrong\./);
  assert.equal(second.match(/The name is wrong\./g)?.length, 1);
});

test("the later reviewer sees the earlier findings", async (t) => {
  const target = await harness(t, { verdicts: [changes("The count is wrong."), APPROVE] });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === "reviewer")[1]!.prompt;
  assert.match(second, /Earlier findings\nRound 1:\n- The count is wrong\./);
});

test("an implementer that changes nothing hands the issue to a person", async (t) => {
  const target = await harness(t, { commits: [false] });
  const report = await target.run();
  assert.equal(report.reason, "no implementation commit");
  assert.equal(report.pr, undefined);
  assert.equal(target.pushes, 0);
});

test("a fixer that changes nothing hands the issue to a person", async (t) => {
  const target = await harness(t, { checks: ["fail"], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, "no fix commit");
  assert.equal(target.pushes, 1);
});

test("a check wait that runs out of time hands the issue to a person", async (t) => {
  const target = await harness(t, { checks: ["timeout"] });
  const report = await target.run();
  assert.equal(report.reason, "checks timeout");
});

test("a repository without checks goes straight to the review", async (t) => {
  const target = await harness(t, { checks: ["none"] });
  assert.equal((await target.run()).outcome, "done");
});

test("a reviewer without a verdict hands the issue to a person", async (t) => {
  const target = await harness(t, { verdicts: [] });
  const report = await target.run();
  assert.equal(report.reason, "no verdict");
});

test("a verdict of the wrong shape counts as no verdict", async (t) => {
  const target = await harness(t, {
    verdicts: [{ verdict: "request_changes", summary: "x" } as unknown as Verdict],
  });
  assert.equal((await target.run()).reason, "no verdict");
});

test("only minor findings give an approval", async (t) => {
  const target = await harness(t, {
    verdicts: [{ verdict: "request_changes", summary: "Taste.", findings: [{ severity: "minor", detail: "long name" }] }],
  });
  assert.equal((await target.run()).outcome, "done");
});

test("a setup command that fails hands the issue to a person", async (t) => {
  const target = await harness(t, { config: { setupCommand: "npm ci" }, setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, "setup failed");
  assert.deepEqual(roles(target), []);
});

test("a setup command that does not finish hands the issue to a person", async (t) => {
  const target = await harness(t, {
    config: { setupCommand: "npm ci", setupTimeoutMinutes: 5 },
    setupCode: 1,
    setupTimedOut: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, "needs-human");
  assert.equal(report.reason, "setup timeout");
  assert.equal(target.labels.at(-1)?.label, "status:needs-human");
  assert.deepEqual(roles(target), []);
});

test("a diff that is too long is cut before the reviewer reads it", async (t) => {
  const target = await harness(t, { config: { diffMaxChars: 20 }, diff: "x".repeat(50) });
  assert.equal((await target.run()).outcome, "done");
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /The diff is cut here, after 20 characters\./);
  assert.equal(prompt.includes("x".repeat(21)), false);
});

test("a diff that fits reaches the reviewer whole", async (t) => {
  const target = await harness(t, { diff: "the whole diff" });
  await target.run();
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /the whole diff/);
  assert.equal(prompt.includes("cut here"), false);
});

test("a step that throws gives the error outcome and hands the issue over", async (t) => {
  const target = await harness(t, { fail: "push" });
  const report = await target.run();
  assert.equal(report.outcome, "error");
  assert.match(report.reason!, /the port broke/);
  assert.equal(target.labels.at(-1)?.label, "status:needs-human");
  assert.equal((await target.state())?.handedOver, true);
  assert.equal((await target.state())?.phase, "implemented");
});

test("a saved state carries on and does not implement again", async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ["status:in-progress"], assignees: ["me"] },
    saved: {
      issue: 7,
      phase: "review",
      branch: "issue-7",
      pr: 101,
      ciFixes: 2,
      reviewRounds: 1,
      reviewLog: [{ round: 1, fingerprint: "old", findings: "- old" }],
    },
  });
  const report = await target.run();
  assert.equal(report.outcome, "done");
  assert.equal(report.ciFixes, 2);
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ["reviewer"]);
});

test("a skipped issue does nothing", async (t) => {
  const target = await harness(t, { issue: { ...ISSUE, labels: [] } });
  const report = await target.run();
  assert.equal(report.outcome, "skipped");
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test("an agent that commits its own work counts as progress", async (t) => {
  const target = await harness(t, { commits: [false], selfCommit: true });
  const report = await target.run();
  assert.equal(report.outcome, "done");
  assert.equal(target.pushes, 1);
});

test("the checks wait for the commit that was pushed", async (t) => {
  const target = await harness(t, { checks: ["fail", "pass"] });
  await target.run();
  assert.deepEqual(target.waits.map((options) => options.head), ["1", "2", "2"]);
});

test("a repository without checks pays the grace time once", async (t) => {
  const target = await harness(t, { checks: ["none"] });
  await target.run();
  assert.deepEqual(target.waits.map((options) => options.graceMs), [60_000, 0]);
});
