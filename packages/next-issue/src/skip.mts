import type { Config } from './config.mts';
import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import type { Issue } from './github.mts';
import { handOverReply } from './hand-over-comments.mts';
import type { Context, IssueReport } from './job.mts';
import { hasLabel } from './labels.mts';
import type { Recorder } from './observe.mts';
import type { IssueState } from './state.mts';

type Skip = 'stop-label' | 'not-ready' | 'in-flight';

export function skipReason(
  issue: Issue,
  config: Config,
  resuming: boolean,
  answered = false,
): Skip | undefined {
  const has = (name: string) => hasLabel(issue.labels, name);
  const names = config.labels;
  const waiting = has(names.needsHuman) && !answered;
  if (has(names.done) || waiting || has(names.skip)) {
    return 'stop-label';
  }
  if (resuming) {
    return undefined;
  }
  if (names.ready.length > 0 && !has(names.ready)) {
    return 'not-ready';
  }
  if (has(names.inProgress) || has(names.inReview)) {
    return 'in-flight';
  }
  return undefined;
}

export async function skipReport(
  context: Context,
  log: Recorder,
  issue: Issue,
  saved: IssueState | undefined,
  started: number,
): Promise<IssueReport | undefined> {
  let answered: boolean;
  try {
    answered = await hasAnswer(context, issue);
  } catch (error) {
    return unclaimedError(log, issue, error, started);
  }
  const skip = skipReason(issue, context.config, saved !== undefined, answered);
  if (skip !== undefined) {
    log.event('issue.skip', { title: issue.title, reason: skip });
    return skipped(issue);
  }
  if (saved !== undefined) {
    return undefined;
  }
  let blockers: string[];
  try {
    blockers = await context.ports.openBlockers(context.repo, issue.number);
  } catch (error) {
    return unclaimedError(log, issue, error, started);
  }
  if (blockers.length > 0) {
    log.event('issue.skip', { title: issue.title, reason: 'blocked', blockers });
    return skipped(issue);
  }
  return undefined;
}

async function hasAnswer(context: Context, issue: Issue): Promise<boolean> {
  if (!hasLabel(issue.labels, context.config.labels.needsHuman)) {
    return false;
  }
  return (await handOverReply(context, issue.number)).length > 0;
}

export function unclaimedError(
  log: Recorder,
  issue: Issue,
  error: unknown,
  started: number,
): IssueReport {
  const { reason, ms } = logIssueError(log, error, started);
  return { ...skipped(issue), outcome: 'error', reason, ms };
}

export function logIssueError(
  log: Recorder,
  error: unknown,
  started: number,
): { reason: string; ms: number } {
  const reason = message(error);
  const ms = elapsedMs(started);
  log.event('issue.error', { error: reason, ms }, 'quiet');
  return { reason, ms };
}

function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
