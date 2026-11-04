import type { Config } from './config.mts';
import type { Issue } from './github.mts';
import { skipped } from './handover.mts';
import type { Context, IssueReport } from './job.mts';
import { message } from './errors.mts';
import { type Recorder } from './observe.mts';
import type { IssueState } from './state.mts';

export type Skip = 'stop-label' | 'not-ready' | 'in-flight';

export function skipReason(issue: Issue, config: Config, resuming: boolean): Skip | undefined {
  const labels = new Set(issue.labels);
  const names = config.labels;
  if (labels.has(names.done) || labels.has(names.needsHuman) || labels.has(names.skip)) {
    return 'stop-label';
  }
  if (resuming) {
    return undefined;
  }
  if (names.ready.length > 0 && !labels.has(names.ready)) {
    return 'not-ready';
  }
  if (labels.has(names.inProgress) || labels.has(names.inReview)) {
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
  const skip = skipReason(issue, context.config, saved !== undefined);
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

export function unclaimedError(
  log: Recorder,
  issue: Issue,
  error: unknown,
  started: number,
): IssueReport {
  log.event('issue.error', { error: message(error), ms: Date.now() - started }, 'quiet');
  return {
    ...skipped(issue),
    outcome: 'error',
    reason: message(error),
    ms: Date.now() - started,
  };
}
