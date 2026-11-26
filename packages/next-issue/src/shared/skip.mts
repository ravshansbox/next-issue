import type { Config } from './config.mts';
import { runStopped } from './children.mts';
import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import type { Repo } from './git.mts';
import type { Issue } from './github.mts';
import { handOverReply } from './hand-over-comments.mts';
import { dropClosed, stopNow } from './handover.mts';
import type { Context, IssueReport } from './job.mts';
import { hasLabel } from './labels.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import { heldByPerson, type IssueState, writeState } from './state.mts';
import { heldOnBase } from './unsettled.mts';

type Skip = 'stop-label' | 'not-ready' | 'in-flight';

export async function listedIssues(
  ports: Pick<Ports, 'openIssues'>,
  repo: Repo,
  config: Config,
  labels: string[],
): Promise<Issue[]> {
  const { ready, needsHuman, skip } = config.labels;
  const search = (blocked: boolean) =>
    ready.length === 0
      ? ports.openIssues(repo, config.issueLimit, [], [], [], blocked)
      : ports.openIssues(
          repo,
          config.issueLimit,
          [ready, ...labels],
          [needsHuman, skip],
          [],
          blocked,
        );
  const issues = new Map<number, Issue>();
  for (const issue of [...(await search(false)), ...(await search(true))]) {
    issues.set(issue.number, issue);
  }
  return [...issues.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function waitingIssues(
  ports: Pick<Ports, 'openIssues'>,
  repo: Repo,
  config: Config,
): Promise<Issue[]> {
  const { ready, needsHuman, skip } = config.labels;
  if (ready.length === 0) {
    return Promise.resolve([]);
  }
  return ports.openIssues(repo, config.issueLimit, [needsHuman], [skip], [ready]);
}

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
    answered = await hasAnswer(context, issue, saved);
  } catch (error) {
    return readError(log, issue, saved, error, started);
  }
  const skip = skipReason(issue, context.config, saved !== undefined, answered);
  if (skip !== undefined) {
    log.event('issue.skip', { title: issue.title, reason: skip });
    if (saved?.halted === true && hasLabel(issue.labels, context.config.labels.skip)) {
      try {
        if (await skippedByWriter(context, issue)) {
          await release(context, log, saved);
        }
      } catch (error) {
        return readError(log, issue, saved, error, started);
      }
    }
    return skipped(issue);
  }
  if (saved !== undefined) {
    return undefined;
  }
  let blockers: string[];
  try {
    blockers = await context.ports.openBlockers(context.repo, issue.number);
  } catch (error) {
    return readError(log, issue, saved, error, started);
  }
  if (blockers.length > 0) {
    log.event('issue.skip', { title: issue.title, reason: 'blocked', blockers });
    return { ...skipped(issue), blocked: true };
  }
  return undefined;
}

export async function closedReport(
  context: Context,
  log: Recorder,
  issue: Issue,
  saved: IssueState | undefined,
  started: number,
): Promise<IssueReport | undefined> {
  let open: boolean;
  try {
    ({ open } = await context.ports.viewIssue(context.repo, issue.number));
  } catch (error) {
    return readError(log, issue, saved, error, started);
  }
  return open ? undefined : dropClosed(context, log, issue, saved);
}

async function release(context: Context, log: Recorder, saved: IssueState): Promise<void> {
  delete saved.halted;
  await writeState(context.repo, saved);
  log.event('land.released', { held: heldOnBase(saved, context.base) });
}

async function skippedByWriter(context: Context, issue: Issue): Promise<boolean> {
  const { ports, repo, config } = context;
  const login = await ports.labeler(repo, issue.number, config.labels.skip);
  return login !== undefined && (await ports.canWrite(repo, login));
}

async function hasAnswer(
  context: Context,
  issue: Issue,
  saved: IssueState | undefined,
): Promise<boolean> {
  if (!hasLabel(issue.labels, context.config.labels.needsHuman)) {
    return false;
  }
  if (heldByPerson(saved)) {
    return false;
  }
  return (await handOverReply(context, issue.number, saved?.pendingHandOver)).length > 0;
}

function readError(
  log: Recorder,
  issue: Issue,
  saved: IssueState | undefined,
  error: unknown,
  started: number,
): IssueReport {
  if (!runStopped()) {
    return unclaimedError(log, issue, error, started);
  }
  if (saved !== undefined) {
    return stopNow(log, issue, saved, started);
  }
  log.event('issue.stop', {});
  return { ...skipped(issue), outcome: 'stopped', ms: elapsedMs(started) };
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
  log.event('issue.error', { error: reason, ms });
  return { reason, ms };
}

function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
