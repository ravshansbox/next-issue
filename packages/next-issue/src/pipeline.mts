import { enterReview } from './enter-review.mts';
import { branchName } from './git.mts';
import type { Issue } from './github.mts';
import { claimedError, stop } from './handover.mts';
import { implement } from './implement.mts';
import type { Context, IssueReport, Run } from './job.mts';
import type { Recorder } from './observe.mts';
import { openJob } from './open-job.mts';
import { reviewRound } from './review.mts';
import { skipReport, unclaimedError } from './skip.mts';
import { type IssueState, newState, readState, resetState } from './state.mts';
import { setUp } from './worktree-setup.mts';

export async function processIssue(context: Context, issue: Issue): Promise<IssueReport> {
  const { repo } = context;
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  let saved: IssueState | undefined;
  try {
    saved = await readState(repo, issue.number);
  } catch (error) {
    return unclaimedError(log, issue, error, started);
  }
  const skip = await skipReport(context, log, issue, saved, started);
  if (skip !== undefined) {
    return skip;
  }
  log.event('issue.start', { title: issue.title, createdAt: issue.createdAt }, 'quiet');

  const state = startState(context, issue, saved);

  try {
    const report = await work(
      context,
      issue,
      log,
      state,
      saved === undefined,
      saved?.handedOver === true,
    );
    log.event(
      'issue.end',
      { outcome: report.outcome, reason: report.reason, ms: report.ms },
      'quiet',
    );
    return report;
  } catch (error) {
    return claimedError(context, log, issue, state, error, started);
  }
}

function startState(context: Context, issue: Issue, saved: IssueState | undefined): IssueState {
  if (saved === undefined) {
    return newState(issue.number, branchName(issue.number));
  }
  return context.reset || saved.handedOver === true ? resetState(saved) : saved;
}

async function work(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  start: boolean,
  handedOver: boolean,
): Promise<IssueReport> {
  const job = await openJob(context, issue, log, state, start, handedOver);
  const setup = await setUp(job);
  if (setup.done) {
    return setup.report;
  }

  if (state.phase === 'claimed') {
    const implemented = await implement(job);
    if (implemented.done) {
      return implemented.report;
    }
  }
  if (context.stopAfterRound()) {
    return stop(job);
  }

  const reviewing = await enterReview(job);
  if (reviewing.done) {
    return reviewing.report;
  }

  return reviewLoop(job);
}

async function reviewLoop(job: Run): Promise<IssueReport> {
  for (;;) {
    if (job.context.stopAfterRound()) {
      return stop(job);
    }
    const round = await reviewRound(job);
    if (round.done) {
      return round.report;
    }
  }
}
