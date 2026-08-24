import { CODING, READ_ONLY, runAgent } from "./agents.mts";
import { type Config, managedLabels } from "./config.mts";
import { run } from "./exec.mts";
import {
  addWorktree,
  branchName,
  commitAll,
  diff,
  push,
  removeWorktree,
  type Repo,
  worktreePath,
} from "./git.mts";
import {
  assignIssue,
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
  fingerprint,
  formatFindings,
  formatVerdict,
  isApproved,
  readVerdict,
  VERDICT_SCHEMA,
} from "./verdict.mts";

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  login: string;
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

export function isClaimable(issue: Issue, config: Config, login: string): boolean {
  const labels = new Set(issue.labels);
  const names = config.labels;
  if (labels.has(names.done) || labels.has(names.needsHuman) || labels.has(names.skip)) {
    return false;
  }
  return issue.assignees.length === 0 || issue.assignees.includes(login);
}

export async function processIssue(context: Context, issue: Issue): Promise<IssueReport> {
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  if (!isClaimable(issue, context.config, context.login)) {
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
    try {
      await handOver(context, log, issue.number, state, `The run failed: ${message(error)}`);
    } catch (failure) {
      log.event("hand-over.error", { error: message(failure) }, "quiet");
    }
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
    await assignIssue(repo, issue.number, context.login);
    await setLabel(repo, issue.number, config.labels.inProgress, managedLabels(config));
    await writeState(repo, state);
  });

  const comments = await log.step("comments", {}, () => issueComments(repo, issue.number));
  const worktree = await log.step("worktree", { branch }, () =>
    addWorktree(repo, issue.number, context.base, config.remote),
  );
  const job: Run = { context, issue, log, state, branch, worktree, comments };
  const escalate = (reason: string): Promise<void> =>
    handOver(context, log, issue.number, state, reason);
  const finish = (outcome: Outcome, reason?: string): IssueReport => ({
    issue: issue.number,
    outcome,
    reason,
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - started,
  });

  if (config.setupCommand !== undefined) {
    const setup = await log.step("setup", { cmd: config.setupCommand }, () =>
      run("bash", ["-lc", config.setupCommand!], { cwd: worktree }),
    );
    if (setup.code !== 0) {
      log.event("setup.fail", { code: setup.code, stderr: setup.stderr.trim().slice(-2000) }, "quiet");
      await escalate("The setup command failed in the worktree.");
      return finish("needs-human", "setup failed");
    }
  }

  if (state.phase === "claimed") {
    const result = await log.step("implement", {}, () =>
      runAgent(log, {
        name: "implementer",
        cwd: worktree,
        prompt: implementPrompt(issue, comments),
        profile: CODING,
        model: config.models.implementer,
      }),
    );
    const subject = parseCommitSubject(result.text, `fix: resolve issue #${issue.number}`);
    if (!(await commitAll(worktree, `${subject}\n\nRefs #${issue.number}`))) {
      await escalate("The implementer produced no change.");
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
      await escalate("The checks did not finish in time.");
      return finish("needs-human", "checks timeout");
    }
    if (checks === "fail") {
      if (state.ciFixes >= config.maxCiFixes) {
        await escalate(`The limit of ${config.maxCiFixes} check fixes was reached.`);
        return finish("needs-human", "check budget");
      }
      state.ciFixes += 1;
      await writeState(repo, state);
      const logs = await failedCheckLogs(repo, branch, config.logMaxChars);
      log.event("checks.logs", { chars: logs.length });
      const committed = await fixRound(job, "The continuous integration checks failed.", logs);
      if (!committed) {
        await escalate("The fixer added no commit for the failed checks.");
        return finish("needs-human", "no fix commit");
      }
      continue;
    }

    if (state.reviewRounds >= config.maxReviewRounds) {
      await escalate(`The limit of ${config.maxReviewRounds} review rounds was reached.`);
      return finish("needs-human", "review budget");
    }
    state.reviewRounds += 1;
    await writeState(repo, state);

    await setLabel(repo, issue.number, config.labels.inReview, managedLabels(config));
    const patch = await diff(worktree, context.base, config.remote);
    const review = await log.step("review", { round: state.reviewRounds, diffChars: patch.length }, () =>
      runAgent(log, {
        name: "reviewer",
        cwd: worktree,
        prompt: reviewPrompt(issue, comments, patch, state.reviewRounds, history(state.reviewLog)),
        profile: READ_ONLY,
        model: config.models.reviewer,
        outputSchema: VERDICT_SCHEMA,
      }),
    );
    const verdict = readVerdict(review.structured);
    if (verdict === undefined) {
      await escalate("The reviewer gave no verdict.");
      return finish("needs-human", "no verdict");
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
      if (!(await removeWorktree(repo, issue.number))) {
        log.event("worktree.kept", { path: worktreePath(repo, issue.number) }, "quiet");
      }
      return finish("done");
    }

    const mark = fingerprint(blocking);
    if (state.reviewLog.some((round) => round.fingerprint === mark)) {
      await escalate("The reviewer repeated findings that an earlier round did not fix.");
      return finish("needs-human", "repeated findings");
    }
    const earlier = history(state.reviewLog);
    state.reviewLog.push({ round: state.reviewRounds, fingerprint: mark, findings: formatFindings(blocking) });
    await writeState(repo, state);

    const committed = await fixRound(job, "The reviewer requested changes.", formatFindings(blocking), earlier);
    if (!committed) {
      await escalate("The fixer added no commit for the review findings.");
      return finish("needs-human", "no fix commit");
    }
  }
}

async function fixRound(job: Run, reason: string, detail: string, earlier: string[] = []): Promise<boolean> {
  const { context, issue, log, worktree, branch } = job;
  const result = await log.step("fix", { reason }, () =>
    runAgent(log, {
      name: "fixer",
      cwd: worktree,
      prompt: fixPrompt(issue, reason, detail, earlier.length > 0 ? earlier : history(job.state.reviewLog)),
      profile: CODING,
      model: context.config.models.fixer,
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

async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
): Promise<void> {
  log.event("hand-over", { reason }, "quiet");
  state.phase = "needs-human";
  await writeState(context.repo, state);
  await setLabel(context.repo, issue, context.config.labels.needsHuman, managedLabels(context.config));
  if (state.pr !== undefined) {
    await commentOnPr(context.repo, state.pr, `next-issue needs help: ${reason}`);
  }
}

function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => `Round ${round.round}:\n${round.findings}`);
}
