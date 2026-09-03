import { CODING, READ_ONLY, runAgent } from "./agents.mts";
import { type Config, managedLabels } from "./config.mts";
import { run } from "./exec.mts";
import {
  addWorktree,
  branchName,
  commitAll,
  diff,
  hasWorktree,
  push,
  removeWorktree,
  type Repo,
  revision,
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
  markPrReady,
  setLabel,
  waitForChecks,
} from "./github.mts";
import { message, type Recorder } from "./observe.mts";
import {
  capDiff,
  type FixKind,
  fixPrompt,
  implementPrompt,
  parseCommitSubject,
  parseUnrelated,
  reviewPrompt,
} from "./prompts.mts";
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

export type Ports = {
  addWorktree: typeof addWorktree;
  assignIssue: typeof assignIssue;
  commentOnPr: typeof commentOnPr;
  commitAll: typeof commitAll;
  createPr: typeof createPr;
  diff: typeof diff;
  failedCheckLogs: typeof failedCheckLogs;
  findPr: typeof findPr;
  hasWorktree: typeof hasWorktree;
  issueComments: typeof issueComments;
  markPrReady: typeof markPrReady;
  push: typeof push;
  removeWorktree: typeof removeWorktree;
  revision: typeof revision;
  runAgent: typeof runAgent;
  runSetup: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number; stderr: string; timedOut?: boolean }>;
  setLabel: typeof setLabel;
  waitForChecks: typeof waitForChecks;
};

export const PORTS: Ports = {
  addWorktree,
  assignIssue,
  commentOnPr,
  commitAll,
  createPr,
  diff,
  failedCheckLogs,
  findPr,
  hasWorktree,
  issueComments,
  markPrReady,
  push,
  removeWorktree,
  revision,
  runAgent,
  runSetup: async (command, cwd, timeoutMs) => run("bash", ["-lc", command], { cwd, timeoutMs }),
  setLabel,
  waitForChecks,
};

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  login: string;
  recorder: Recorder;
  ports: Ports;
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

export type Skip = "stop-label" | "not-ready" | "in-flight" | "assigned";

type Gate = { done: true; report: IssueReport } | { done: false; fixed: boolean };

type Fix = { committed: true } | { committed: false; unrelated?: string };

export function skipReason(
  issue: Issue,
  config: Config,
  login: string,
  resuming: boolean,
): Skip | undefined {
  const labels = new Set(issue.labels);
  const names = config.labels;
  if (labels.has(names.done) || labels.has(names.needsHuman) || labels.has(names.skip)) {
    return "stop-label";
  }
  if (resuming) {
    return issue.assignees.every((name) => name === login) ? undefined : "assigned";
  }
  if (names.ready.length > 0 && !labels.has(names.ready)) {
    return "not-ready";
  }
  if (labels.has(names.inProgress) || labels.has(names.inReview)) {
    return "in-flight";
  }
  return issue.assignees.length === 0 ? undefined : "assigned";
}

export async function processIssue(context: Context, issue: Issue): Promise<IssueReport> {
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  const saved = await readState(context.repo, issue.number);
  const skip = skipReason(issue, context.config, context.login, saved !== undefined);
  if (skip !== undefined) {
    log.event("issue.skip", { title: issue.title, reason: skip });
    return { issue: issue.number, outcome: "skipped", ciFixes: 0, reviewRounds: 0, ms: 0 };
  }
  log.event("issue.start", { title: issue.title, createdAt: issue.createdAt }, "quiet");

  const state = saved ?? {
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
    await cleanUp(context, log, issue.number);
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
  const { repo, config, ports } = context;
  const branch = state.branch;

  await log.step("claim", { label: config.labels.inProgress }, async () => {
    await ports.assignIssue(repo, issue.number, context.login);
    await setStatus(context, issue.number, state.pr, config.labels.inProgress);
    await writeState(repo, state);
  });

  const comments = await log.step("comments", {}, () => ports.issueComments(repo, issue.number));
  const worktree = await log.step("worktree", { branch }, () =>
    ports.addWorktree(repo, issue.number, context.base, config.remote),
  );
  const job: Run = { context, issue, log, state, branch, worktree, comments };
  const escalate = (reason: string): Promise<void> =>
    handOver(context, log, issue.number, state, reason);
  const finish = async (outcome: Outcome, reason?: string): Promise<IssueReport> => {
    await cleanUp(context, log, issue.number);
    return {
      issue: issue.number,
      outcome,
      reason,
      pr: state.pr,
      ciFixes: state.ciFixes,
      reviewRounds: state.reviewRounds,
      ms: Date.now() - started,
    };
  };

  if (config.setupCommand !== undefined) {
    const setup = await log.step("setup", { cmd: config.setupCommand }, () =>
      ports.runSetup(config.setupCommand!, worktree, config.setupTimeoutMinutes * 60_000),
    );
    if (setup.code !== 0) {
      const late = setup.timedOut === true;
      log.event(
        "setup.fail",
        { code: setup.code, timedOut: late, stderr: setup.stderr.trim().slice(-2000) },
        "quiet",
      );
      await escalate(
        late
          ? `The setup command did not finish in ${config.setupTimeoutMinutes} minutes.`
          : "The setup command failed in the worktree.",
      );
      return finish("needs-human", late ? "setup timeout" : "setup failed");
    }
  }

  if (state.phase === "claimed") {
    const before = await ports.revision(worktree);
    const result = await log.step("implement", {}, () =>
      ports.runAgent(log, {
        name: "implementer",
        cwd: worktree,
        prompt: implementPrompt(issue, comments),
        profile: CODING,
        model: config.models.implementer,
        timeoutMs: config.agentTimeoutMinutes * 60_000,
      }),
    );
    const subject = parseCommitSubject(result.text, `fix: resolve issue #${issue.number}`);
    if (!(await commitWork(job, before, subject))) {
      await escalate("The implementer produced no change.");
      return finish("needs-human", "no implementation commit");
    }
    state.phase = "implemented";
    await writeState(repo, state);
  }

  await log.step("push", { branch }, () => ports.push(worktree, config.remote, branch));
  state.pr = await log.step("pull-request", { branch }, async () => {
    const existing = await ports.findPr(repo, branch);
    return (
      existing ??
      ports.createPr(
        repo,
        branch,
        context.base,
        issue.title,
        `Closes #${issue.number}\n\nOpened by next-issue.`,
        config.draftPullRequest,
      )
    );
  });
  state.phase = "review";
  await writeState(repo, state);
  log.event("pull-request.ready", { pr: state.pr }, "quiet");

  let noChecks = false;
  const gate = async (): Promise<Gate> => {
    const head = await ports.revision(worktree);
    const checks = await log.step("checks", { pr: state.pr, head }, () =>
      ports.waitForChecks(repo, branch, {
        head,
        intervalSeconds: config.checkIntervalSeconds,
        graceMs: noChecks ? 0 : config.checkGraceSeconds * 1000,
        timeoutMs: config.checkTimeoutMinutes * 60_000,
        show: log.level === "verbose",
      }),
    );
    log.event("checks.state", { state: checks });
    noChecks ||= checks === "none";
    if (checks === "timeout") {
      await escalate("The checks did not finish in time.");
      return { done: true, report: await finish("needs-human", "checks timeout") };
    }
    if (checks !== "fail") {
      return { done: false, fixed: false };
    }
    if (state.ciFixes >= config.maxCiFixes) {
      await escalate(`The limit of ${config.maxCiFixes} check fixes was reached.`);
      return { done: true, report: await finish("needs-human", "check budget") };
    }
    state.ciFixes += 1;
    await writeState(repo, state);
    const logs = await ports.failedCheckLogs(repo, branch, config.logMaxChars);
    log.event("checks.logs", { chars: logs.length });
    const fix = await fixRound(
      job,
      "The continuous integration checks failed.",
      logs,
      history(state.reviewLog),
      "checks",
    );
    if (!fix.committed) {
      const note = fix.unrelated;
      await escalate(
        note === undefined
          ? "The fixer added no commit for the failed checks."
          : `The checks fail for a reason this change did not cause: ${note}`,
      );
      return {
        done: true,
        report: await finish("needs-human", note === undefined ? "no fix commit" : "unrelated failure"),
      };
    }
    return { done: false, fixed: true };
  };

  for (;;) {
    const before = await gate();
    if (before.done) {
      return before.report;
    }
    if (before.fixed) {
      continue;
    }

    if (state.reviewRounds >= config.maxReviewRounds) {
      await escalate(`The limit of ${config.maxReviewRounds} review rounds was reached.`);
      return finish("needs-human", "review budget");
    }
    state.reviewRounds += 1;
    await writeState(repo, state);

    await setStatus(context, issue.number, state.pr, config.labels.inReview);
    const full = await ports.diff(worktree, context.base, config.remote);
    const patch = capDiff(full, config.diffMaxChars);
    const fields = {
      round: state.reviewRounds,
      diffChars: full.length,
      cut: full.length > config.diffMaxChars,
    };
    const review = await log.step("review", fields, () =>
      ports.runAgent(log, {
        name: "reviewer",
        cwd: worktree,
        prompt: reviewPrompt(issue, comments, patch, history(state.reviewLog)),
        profile: READ_ONLY,
        model: config.models.reviewer,
        timeoutMs: config.agentTimeoutMinutes * 60_000,
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
    await ports.commentOnPr(repo, state.pr, formatVerdict(verdict));

    if (isApproved(verdict)) {
      const after = await gate();
      if (after.done) {
        return after.report;
      }
      if (after.fixed) {
        continue;
      }
      if (config.draftPullRequest && !(await ports.markPrReady(repo, state.pr))) {
        log.event("pull-request.undraft.fail", { pr: state.pr }, "quiet");
      }
      await setStatus(context, issue.number, state.pr, config.labels.done);
      state.phase = "done";
      await writeState(repo, state);
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

    const fix = await fixRound(
      job,
      "The reviewer requested changes.",
      formatFindings(blocking),
      earlier,
      "review",
    );
    if (!fix.committed) {
      await escalate("The fixer added no commit for the review findings.");
      return finish("needs-human", "no fix commit");
    }
  }
}

async function fixRound(
  job: Run,
  reason: string,
  detail: string,
  earlier: string[],
  kind: FixKind,
): Promise<Fix> {
  const { context, issue, log, worktree, branch } = job;
  const { ports } = context;
  const before = await ports.revision(worktree);
  const result = await log.step("fix", { reason }, () =>
    ports.runAgent(log, {
      name: "fixer",
      cwd: worktree,
      prompt: fixPrompt(issue, reason, detail, earlier, kind),
      profile: CODING,
      model: context.config.models.fixer,
      timeoutMs: context.config.agentTimeoutMinutes * 60_000,
    }),
  );
  const unrelated = parseUnrelated(result.text);
  if (unrelated !== undefined) {
    log.event("fix.unrelated", { reason, note: unrelated }, "quiet");
    return { committed: false, unrelated };
  }
  const subject = parseCommitSubject(result.text, `fix: address feedback on issue #${issue.number}`);
  if (!(await commitWork(job, before, subject))) {
    log.event("commit.empty", { reason }, "quiet");
    return { committed: false };
  }
  await ports.push(worktree, context.config.remote, branch);
  return { committed: true };
}

async function commitWork(job: Run, before: string, subject: string): Promise<boolean> {
  const { context, issue, log, worktree } = job;
  if (await context.ports.commitAll(worktree, `${subject}\n\nRefs #${issue.number}`)) {
    log.event("commit", { subject });
  }
  return (await context.ports.revision(worktree)) !== before;
}

async function cleanUp(context: Context, log: Recorder, issue: number): Promise<void> {
  const path = worktreePath(context.repo, issue);
  try {
    if (!(await context.ports.hasWorktree(context.repo, path))) {
      return;
    }
    if (!(await context.ports.removeWorktree(context.repo, issue))) {
      log.event("worktree.kept", { path }, "quiet");
    }
  } catch (error) {
    log.event("worktree.error", { error: message(error) }, "quiet");
  }
}

async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
): Promise<void> {
  log.event("hand-over", { reason }, "quiet");
  state.handedOver = true;
  await writeState(context.repo, state);
  await setStatus(context, issue, state.pr, context.config.labels.needsHuman);
  if (state.pr !== undefined) {
    await context.ports.commentOnPr(context.repo, state.pr, `next-issue needs help: ${reason}`);
  }
}

async function setStatus(
  context: Context,
  issue: number,
  pr: number | undefined,
  label: string,
): Promise<void> {
  const managed = managedLabels(context.config);
  await context.ports.setLabel(context.repo, "issue", issue, label, managed);
  if (pr !== undefined) {
    await context.ports.setLabel(context.repo, "pr", pr, label, managed);
  }
}

function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => `Round ${round.round}:\n${round.findings}`);
}
