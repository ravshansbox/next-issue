import { managedLabels } from './config.mts';
import type { Issue } from './github.mts';
import { message, type Recorder } from './observe.mts';
import type { Context, IssueReport, Outcome } from './ports.mts';
import { dropState, type IssueState, type ReviewRound, writeState } from './state.mts';

export type Run = {
  context: Context;
  issue: Issue;
  log: Recorder;
  state: IssueState;
  branch: string;
  worktree: string;
  comments: string[];
  started: number;
  noChecks: boolean;
  mainBroken: boolean;
};

export type Gate = { done: true; report: IssueReport } | { done: false; fixed: boolean };

export type Round = { done: true; report: IssueReport } | { done: false };

export async function openPr(job: Run): Promise<void> {
  const { context, issue, log, state, branch } = job;
  const { repo, config, ports } = context;
  const pr = await log.step('pull-request', { branch }, async () => {
    const existing = await ports.findPr(repo, branch);
    return (
      existing ??
      ports.createPr(
        repo,
        branch,
        context.base,
        state.title ?? `fix: resolve issue #${issue.number}`,
        `Closes #${issue.number}\n\nOpened by next-issue.`,
        config.draftPullRequest,
      )
    );
  });
  state.pr = pr;
  await writeState(repo, state);
  log.event('pull-request.ready', { pr }, 'quiet');
}

export function escalate(job: Run, reason: string): Promise<void> {
  return handOver(job.context, job.log, job.issue.number, job.state, reason);
}

export function stop(job: Run): IssueReport {
  const { issue, log, state } = job;
  log.event('issue.stop', { phase: state.phase }, 'quiet');
  return {
    issue: issue.number,
    outcome: 'stopped',
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - job.started,
  };
}

export async function finish(job: Run, outcome: Outcome, reason?: string): Promise<IssueReport> {
  const { context, issue, log, state, branch } = job;
  const { repo, ports } = context;
  await cleanUp(context, log, branch);
  if (outcome === 'done') {
    for (const name of [branch, ...(await ports.disputeBranches(repo, branch))]) {
      if (!(await ports.deleteBranch(repo, name))) {
        log.event('branch.kept', { branch: name }, 'quiet');
      }
    }
    await dropState(repo, issue.number);
  }
  return {
    issue: issue.number,
    outcome,
    reason,
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - job.started,
    ...(job.mainBroken && outcome !== 'done' ? { halt: true } : {}),
  };
}

export async function cleanUp(context: Context, log: Recorder, branch: string): Promise<void> {
  try {
    const path = await context.ports.findWorktree(context.repo, branch);
    if (path === undefined) {
      return;
    }
    if (!(await context.ports.removeWorktree(context.repo, path))) {
      log.event('worktree.kept', { path }, 'quiet');
    }
  } catch (error) {
    log.event('worktree.error', { error: message(error) }, 'quiet');
  }
}

export async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
): Promise<void> {
  log.event('hand-over', { reason }, 'quiet');
  await writeState(context.repo, state);
  await setStatus(context, issue, state.pr, context.config.labels.needsHuman);
  const body = `next-issue needs help: ${reason}`;
  if (state.pr === undefined) {
    await context.ports.commentOnIssue(context.repo, issue, body);
  } else {
    await context.ports.commentOnPr(context.repo, state.pr, body);
  }
}

export async function setStatus(
  context: Context,
  issue: number,
  pr: number | undefined,
  label: string,
): Promise<void> {
  const managed = managedLabels(context.config);
  await context.ports.setLabel(context.repo, 'issue', issue, label, managed);
  if (pr !== undefined) {
    await context.ports.setLabel(context.repo, 'pr', pr, label, managed);
  }
}

export function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => {
    const head = `Round ${round.round}:\n${round.findings}`;
    return round.dispute === undefined
      ? head
      : `${head}\nThe fixer disputed every finding of this round: ${round.dispute}`;
  });
}
