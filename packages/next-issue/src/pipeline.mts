import { untrustedEditors } from './editors.mts';
import { enterReview, settleSquash } from './enter-review.mts';
import { branchName } from './git.mts';
import type { Issue } from './github.mts';
import { runStopped } from './children.mts';
import { claimedError, dropClosed, finishClosing, stop, stopNow } from './handover.mts';
import { implement } from './implement.mts';
import type { Context, IssueReport, Run } from './job.mts';
import type { Recorder } from './observe.mts';
import { openJob } from './open-job.mts';
import { reviewRound, settleReview } from './review.mts';
import { skipReport, unclaimedError } from './skip.mts';
import { hasLabel } from './labels.mts';
import {
  type IssueState,
  type PendingHandOver,
  newState,
  readState,
  resetState,
} from './state.mts';
import { beforeBaseSettled } from './unsettled.mts';
import { setUp } from './worktree-setup.mts';

export async function processIssue(
  context: Context,
  issue: Issue,
  claimed: () => void = () => undefined,
): Promise<IssueReport> {
  const { repo } = context;
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  let saved: IssueState | undefined;
  try {
    saved = await readState(repo, issue.number);
  } catch (error) {
    return unclaimedError(log, issue, error, started);
  }
  const handedOver = wasHandedOver(context, issue, saved);
  // A hand-over takes a closing issue back: its resume may revert or add to the change.
  const closing = saved?.closing === true && !handedOver;
  if (issue.closed === true && !closing) {
    return dropClosed(context, log, issue, saved?.branch ?? branchName(issue.number));
  }
  const skip = closing ? undefined : await skipReport(context, log, issue, saved, started);
  if (skip !== undefined) {
    return skip;
  }
  claimed();
  log.event('issue.start', { title: issue.title, createdAt: issue.createdAt }, 'quiet');

  const state = startState(context, issue, saved, handedOver);

  let report: IssueReport;
  try {
    report = closing
      ? await finishClosing(context, issue, log, state, started)
      : await work(
          context,
          issue,
          log,
          state,
          saved === undefined,
          handedOver,
          saved?.pendingHandOver,
        );
  } catch (error) {
    if (!runStopped()) {
      return claimedError(context, log, issue, state, error, started);
    }
    report = stopNow(log, issue, state, started);
  }
  log.event(
    'issue.end',
    { outcome: report.outcome, reason: report.reason, ms: report.ms },
    'quiet',
  );
  return report;
}

/**
 * A hand-over whose comment failed counts once its label reached GitHub (a person who takes it off retries),
 * or once the issue is claimed with its label still on, that is with an answer.
 */
function wasHandedOver(context: Context, issue: Issue, saved: IssueState | undefined): boolean {
  if (saved?.handedOver === true) {
    return true;
  }
  const pending = saved?.pendingHandOver;
  return (
    pending !== undefined &&
    (pending.labelled === true || hasLabel(issue.labels, context.config.labels.needsHuman))
  );
}

function startState(
  context: Context,
  issue: Issue,
  saved: IssueState | undefined,
  handedOver: boolean,
): IssueState {
  if (saved === undefined) {
    return newState(issue.number, branchName(issue.number));
  }
  const { pendingHandOver: _pending, ...rest } = saved;
  return context.reset || handedOver ? resetState(saved, handedOver) : rest;
}

async function work(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  start: boolean,
  handedOver: boolean,
  pending: PendingHandOver | undefined,
): Promise<IssueReport> {
  const { job, setup } = await beforeBaseSettled(state, context.base, async () => {
    const opened = await openJob(context, issue, log, state, start, handedOver, pending);
    await settleReview(opened);
    await settleSquash(opened);
    return { job: opened, setup: await setUp(opened) };
  });
  if (setup.done) {
    return setup.report;
  }
  const untrusted = await untrustedEditors(job);
  if (untrusted !== undefined) {
    return untrusted.report;
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
