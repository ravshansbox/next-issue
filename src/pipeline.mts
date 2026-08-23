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
import { fixPrompt, implementPrompt, parseCommitSubject, reviewPrompt } from "./prompts.mts";
import { readState, writeState } from "./state.mts";
import { createVerdictTool, formatVerdict } from "./verdict.mts";

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  login: string;
  modelRuntime: ModelRuntime;
};

export type Outcome = "done" | "needs-human" | "skipped";

export function isClaimable(issue: Issue, context: Context): boolean {
  const labels = new Set(issue.labels);
  const { labels: names } = context.config;
  if (labels.has(names.done) || labels.has(names.needsHuman) || labels.has(names.skip)) {
    return false;
  }
  return issue.assignees.length === 0 || issue.assignees.includes(context.login);
}

export async function processIssue(context: Context, issue: Issue): Promise<Outcome> {
  const { repo, config } = context;
  if (!isClaimable(issue, context)) {
    return "skipped";
  }

  const branch = branchName(issue.number);
  const state = (await readState(repo, issue.number)) ?? {
    issue: issue.number,
    phase: "claimed" as const,
    branch,
    ciFixes: 0,
    reviewRounds: 0,
  };

  log(`issue #${issue.number}: ${issue.title}`);
  await claimIssue(repo, issue.number, context.login, config.labels.inProgress);
  await writeState(repo, state);

  const comments = await issueComments(repo, issue.number);
  const worktree = await addWorktree(repo, issue.number, context.base, config.remote);

  if (state.phase === "claimed") {
    log("implementing");
    const output = await runAgent(context.modelRuntime, {
      name: "implementer",
      cwd: worktree,
      prompt: implementPrompt(issue, comments),
      modelSpec: config.models.implementer,
      tools: CODING_TOOLS,
    });
    const subject = parseCommitSubject(output, `fix: resolve issue #${issue.number}`);
    if (!(await commitAll(worktree, `${subject}\n\nRefs #${issue.number}`))) {
      await handOver(context, issue, undefined, "The implementer produced no change.");
      return "needs-human";
    }
    state.phase = "implemented";
    await writeState(repo, state);
  }

  await push(worktree, config.remote, branch);
  state.pr =
    (await findPr(repo, branch)) ??
    (await createPr(
      repo,
      branch,
      context.base,
      issue.title,
      `Closes #${issue.number}\n\nOpened by next-issue.`,
    ));
  state.phase = "review";
  await writeState(repo, state);
  log(`pull request #${state.pr}`);

  for (;;) {
    log("waiting for the checks");
    const checks = await waitForChecks(
      repo,
      branch,
      config.checkIntervalSeconds,
      config.checkTimeoutMinutes * 60_000,
    );
    if (checks === "timeout") {
      await handOver(context, issue, state.pr, "The checks did not finish in time.");
      return "needs-human";
    }
    if (checks === "fail") {
      if (state.ciFixes >= config.maxCiFixes) {
        await handOver(context, issue, state.pr, `The limit of ${config.maxCiFixes} check fixes was reached.`);
        state.phase = "needs-human";
        await writeState(repo, state);
        return "needs-human";
      }
      state.ciFixes += 1;
      await writeState(repo, state);
      const logs = await failedCheckLogs(repo, branch, config.logMaxChars);
      const committed = await fix(
        context,
        issue,
        worktree,
        branch,
        "The continuous integration checks failed.",
        logs,
      );
      if (!committed) {
        await handOver(context, issue, state.pr, "The fixer added no commit for the failed checks.");
        state.phase = "needs-human";
        await writeState(repo, state);
        return "needs-human";
      }
      continue;
    }

    if (state.reviewRounds >= config.maxReviewRounds) {
      await handOver(context, issue, state.pr, `The limit of ${config.maxReviewRounds} review rounds was reached.`);
      state.phase = "needs-human";
      await writeState(repo, state);
      return "needs-human";
    }
    state.reviewRounds += 1;
    await writeState(repo, state);

    log(`review round ${state.reviewRounds}`);
    await setLabel(repo, issue.number, config.labels.inReview, managedLabels(config));
    const verdictTool = createVerdictTool();
    await runAgent(context.modelRuntime, {
      name: "reviewer",
      cwd: worktree,
      prompt: reviewPrompt(issue, comments, await diff(worktree, context.base, config.remote)),
      modelSpec: config.models.reviewer,
      tools: READ_ONLY_TOOLS,
      customTools: [verdictTool.tool],
    });
    const verdict = verdictTool.read();
    if (verdict === undefined) {
      await handOver(context, issue, state.pr, "The reviewer gave no verdict.");
      return "needs-human";
    }
    await commentOnPr(repo, state.pr, formatVerdict(verdict));
    if (verdict.verdict === "approve") {
      await setLabel(repo, issue.number, config.labels.done, managedLabels(config));
      state.phase = "done";
      await writeState(repo, state);
      await removeWorktree(repo, issue.number);
      log(`done, pull request #${state.pr} waits for your merge`);
      return "done";
    }
    const committed = await fix(
      context,
      issue,
      worktree,
      branch,
      "The reviewer requested changes.",
      formatVerdict(verdict),
    );
    if (!committed) {
      await handOver(context, issue, state.pr, "The fixer added no commit for the review findings.");
      state.phase = "needs-human";
      await writeState(repo, state);
      return "needs-human";
    }
  }
}

async function fix(
  context: Context,
  issue: Issue,
  worktree: string,
  branch: string,
  reason: string,
  detail: string,
): Promise<boolean> {
  log(`fixing: ${reason}`);
  const output = await runAgent(context.modelRuntime, {
    name: "fixer",
    cwd: worktree,
    prompt: fixPrompt(issue, reason, detail),
    modelSpec: context.config.models.fixer,
    tools: CODING_TOOLS,
  });
  const subject = parseCommitSubject(output, `fix: address feedback on issue #${issue.number}`);
  if (!(await commitAll(worktree, `${subject}\n\nRefs #${issue.number}`))) {
    return false;
  }
  await push(worktree, context.config.remote, branch);
  return true;
}

async function handOver(
  context: Context,
  issue: Issue,
  pr: number | undefined,
  reason: string,
): Promise<void> {
  log(`hand over: ${reason}`);
  await setLabel(context.repo, issue.number, context.config.labels.needsHuman, managedLabels(context.config));
  if (pr !== undefined) {
    await commentOnPr(context.repo, pr, `next-issue needs help: ${reason}`);
  }
}

function log(message: string): void {
  process.stderr.write(`[next-issue] ${message}\n`);
}
