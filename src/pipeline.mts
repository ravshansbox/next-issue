import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CODING_TOOLS, READ_ONLY_TOOLS, runAgent } from "./agents.mts";
import { type Config, managedLabels } from "./config.mts";
import {
  addWorktree,
  branchName,
  commitAll,
  diff,
  push,
  removeWorktree,
  type Repo,
} from "./git.mts";
import {
  claimIssue,
  commentOnPr,
  createPr,
  failedCheckLogs,
  findPr,
  type Issue,
  issueComments,
  setLabel,
  waitForChecks,
} from "./github.mts";
import { message, type Recorder } from "./observe.mts";
import { fixPrompt, implementPrompt, parseCommitSubject, reviewPrompt } from "./prompts.mts";
import { type IssueState, readState, type ReviewRound, writeState } from "./state.mts";
import {
  blockingFindings,
  createVerdictTool,
  fingerprint,
  formatFindings,
  formatVerdict,
  isApproved,
} from "./verdict.mts";

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  login: string;
  modelRuntime: ModelRuntime;
  recorder: Recorder;
};

export type Outcome = "done" | "needs-human" | "skipped" | "error";

export type IssueReport = {
  issue: number;
  outcome: Outcome;
  reason?: string;
  pr?: number;
  ciFixes: number;
  reviewRounds: number;
  ms: number;
};

type Run = {
  context: Context;
  issue: Issue;
  log: Recorder;
  state: IssueState;
  branch: string;
  worktree: string;
  comments: string[];
};

export function isClaimable(issue: Issue, context: Context): boolean {
  const labels = new Set(issue.labels);
  const { labels: names } = context.config;
  if (labels.has(names.done) || labels.has(names.needsHuman) || labels.has(names.skip)) {
    return false;
  }
  return issue.assignees.length === 0 || issue.assignees.includes(context.login);
}

export async function processIssue(context: Context, issue: Issue): Promise<IssueReport> {
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  if (!isClaimable(issue, context)) {
    log.event("issue.skip", { title: issue.title });
    return { issue: issue.number, outcome: "skipped", ciFixes: 0, reviewRounds: 0, ms: 0 };
  }
  log.event("issue.start", { title: issue.title, createdAt: issue.createdAt }, "quiet");

  const state = (await readState(context.repo, issue.number)) ?? {
    issue: issue.number,
    phase: "claimed" as const,
    branch: branchName(issue.number),
    ciFixes: 0,
    reviewRounds: 0,
    reviewLog: [],
  };

  try {
    const report = await work(context, issue, log, state);
    log.event("issue.end", { outcome: report.outcome, reason: report.reason, ms: report.ms }, "quiet");
    return report;
  } catch (error) {
    log.event("issue.error", { error: message(error), ms: Date.now() - started }, "quiet");
    return {
      issue: issue.number,
      outcome: "error",
      reason: message(error),
      pr: state.pr,
      ciFixes: state.ciFixes,
      reviewRounds: state.reviewRounds,
      ms: Date.now() - started,
    };
  }
}

async function work(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
): Promise<IssueReport> {
  const started = Date.now();
  const { repo, config } = context;
  const branch = state.branch;

  await log.step("claim", { label: config.labels.inProgress }, async () => {
    await claimIssue(repo, issue.number, context.login, config.labels.inProgress);
    await writeState(repo, state);
  });

  const comments = await log.step("comments", {}, () => issueComments(repo, issue.number));
  const worktree = await log.step("worktree", { branch }, () =>
    addWorktree(repo, issue.number, context.base, config.remote),
  );
  const run: Run = { context, issue, log, state, branch, worktree, comments };
  const finish = (outcome: Outcome, reason?: string): IssueReport => ({
    issue: issue.number,
    outcome,
    reason,
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - started,
  });

  if (state.phase === "claimed") {
    const result = await log.step("implement", {}, () =>
      runAgent(context.modelRuntime, log, {
        name: "implementer",
        cwd: worktree,
        prompt: implementPrompt(issue, comments),
        tools: CODING_TOOLS,
      }),
    );
    const subject = parseCommitSubject(result.text, `fix: resolve issue #${issue.number}`);
    if (!(await commitAll(worktree, `${subject}\n\nRefs #${issue.number}`))) {
      await handOver(run, "The implementer produced no change.");
      return finish("needs-human", "no implementation commit");
    }
    log.event("commit", { subject });
    state.phase = "implemented";
    await writeState(repo, state);
  }

  await log.step("push", { branch }, () => push(worktree, config.remote, branch));
  state.pr = await log.step("pull-request", { branch }, async () => {
    const existing = await findPr(repo, branch);
    return (
      existing ??
      createPr(repo, branch, context.base, issue.title, `Closes #${issue.number}\n\nOpened by next-issue.`)
    );
  });
  state.phase = "review";
  await writeState(repo, state);
  log.event("pull-request.ready", { pr: state.pr }, "quiet");

  for (;;) {
    const checks = await log.step("checks", { pr: state.pr }, () =>
      waitForChecks(repo, branch, config.checkIntervalSeconds, config.checkTimeoutMinutes * 60_000),
    );
    log.event("checks.state", { state: checks });
    if (checks === "timeout") {
      await handOver(run, "The checks did not finish in time.");
      return finish("needs-human", "checks timeout");
    }
    if (checks === "fail") {
      if (state.ciFixes >= config.maxCiFixes) {
        await handOver(run, `The limit of ${config.maxCiFixes} check fixes was reached.`);
        return await stop(run, finish("needs-human", "check budget"));
      }
      state.ciFixes += 1;
      await writeState(repo, state);
      const logs = await failedCheckLogs(repo, branch, config.logMaxChars);
      log.event("checks.logs", { chars: logs.length });
      const committed = await fixRound(run, "The continuous integration checks failed.", logs);
      if (!committed) {
        await handOver(run, "The fixer added no commit for the failed checks.");
        return await stop(run, finish("needs-human", "no fix commit"));
      }
      continue;
    }

    if (state.reviewRounds >= config.maxReviewRounds) {
      await handOver(run, `The limit of ${config.maxReviewRounds} review rounds was reached.`);
      return await stop(run, finish("needs-human", "review budget"));
    }
    state.reviewRounds += 1;
    await writeState(repo, state);

    await setLabel(repo, issue.number, config.labels.inReview, managedLabels(config));
    const verdictTool = createVerdictTool();
    const patch = await diff(worktree, context.base, config.remote);
    await log.step("review", { round: state.reviewRounds, diffChars: patch.length }, () =>
      runAgent(context.modelRuntime, log, {
        name: "reviewer",
        cwd: worktree,
        prompt: reviewPrompt(issue, comments, patch, state.reviewRounds, history(state.reviewLog)),
        tools: READ_ONLY_TOOLS,
        customTools: [verdictTool.tool],
      }),
    );
    const verdict = verdictTool.read();
    if (verdict === undefined) {
      await handOver(run, "The reviewer gave no verdict.");
      return await stop(run, finish("needs-human", "no verdict"));
    }
    const blocking = blockingFindings(verdict);
    log.event("verdict", {
      round: state.reviewRounds,
      verdict: verdict.verdict,
      blocking: blocking.length,
      minor: verdict.findings.length - blocking.length,
      summary: verdict.summary,
    }, "quiet");
    await commentOnPr(repo, state.pr, formatVerdict(verdict));

    if (isApproved(verdict)) {
      await setLabel(repo, issue.number, config.labels.done, managedLabels(config));
      state.phase = "done";
      await writeState(repo, state);
      await removeWorktree(repo, issue.number);
      return finish("done");
    }

    const mark = fingerprint(blocking);
    if (state.reviewLog.some((round) => round.fingerprint === mark)) {
      await handOver(run, "The reviewer repeated findings that an earlier round did not fix.");
      return await stop(run, finish("needs-human", "repeated findings"));
    }
    const earlier = history(state.reviewLog);
    state.reviewLog.push({ round: state.reviewRounds, fingerprint: mark, findings: formatFindings(blocking) });
    await writeState(repo, state);

    const committed = await fixRound(run, "The reviewer requested changes.", formatFindings(blocking), earlier);
    if (!committed) {
      await handOver(run, "The fixer added no commit for the review findings.");
      return await stop(run, finish("needs-human", "no fix commit"));
    }
  }
}

async function fixRound(run: Run, reason: string, detail: string, earlier: string[] = []): Promise<boolean> {
  const { context, issue, log, worktree, branch } = run;
  const result = await log.step("fix", { reason }, () =>
    runAgent(context.modelRuntime, log, {
      name: "fixer",
      cwd: worktree,
      prompt: fixPrompt(issue, reason, detail, earlier.length > 0 ? earlier : history(run.state.reviewLog)),
      tools: CODING_TOOLS,
    }),
  );
  const subject = parseCommitSubject(result.text, `fix: address feedback on issue #${issue.number}`);
  if (!(await commitAll(worktree, `${subject}\n\nRefs #${issue.number}`))) {
    log.event("commit.empty", { reason }, "quiet");
    return false;
  }
  log.event("commit", { subject });
  await push(worktree, context.config.remote, branch);
  return true;
}

async function handOver(run: Run, reason: string): Promise<void> {
  const { context, issue, log, state } = run;
  log.event("hand-over", { reason }, "quiet");
  await setLabel(context.repo, issue.number, context.config.labels.needsHuman, managedLabels(context.config));
  if (state.pr !== undefined) {
    await commentOnPr(context.repo, state.pr, `next-issue needs help: ${reason}`);
  }
}

async function stop(run: Run, report: IssueReport): Promise<IssueReport> {
  run.state.phase = "needs-human";
  await writeState(run.context.repo, run.state);
  return report;
}

function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => `Round ${round.round}:\n${round.findings}`);
}
