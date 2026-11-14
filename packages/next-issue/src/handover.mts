import { runStopped } from './children.mts';
import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import type { Issue } from './github.mts';
import { HAND_OVER } from './hand-over-comments.mts';
import {
  type Context,
  type Finished,
  type IssueReport,
  type Outcome,
  type Run,
  setStatus,
} from './job.mts';
import { oneAtATime } from './lock.mts';
import type { Fields, Recorder } from './observe.mts';
import { revertFailedFix } from './revert.mts';
import { logIssueError } from './skip.mts';
import { dropState, type IssueState, writeState } from './state.mts';

export async function escalateAndFinish(job: Run, note: string, reason: string): Promise<Finished> {
  const reverted = await revertFailedFix(job);
  try {
    await handOver(job.context, job.log, job.issue.number, job.state, `${note}${reverted}`);
  } catch (error) {
    if (!job.mainBroken || runStopped()) {
      throw error;
    }
    const failure = message(error);
    job.log.event('hand-over.error', { reason, error: failure }, 'quiet');
    return {
      done: true,
      report: await finish(job, 'error', `${reason}; the hand-over failed: ${failure}`),
    };
  }
  return { done: true, report: await finish(job, 'needs-human', reason) };
}

export async function finishDone(job: Run): Promise<Finished> {
  const { context, issue } = job;
  await setStatus(context, issue.number, context.config.labels.done);
  await context.ports.closeIssue(context.repo, issue.number);
  await updateLocalBase(job);
  return { done: true, report: await finish(job, 'done') };
}

async function updateLocalBase(job: Run): Promise<void> {
  const { context, log } = job;
  const { repo, ports, config, base } = context;
  const updated = await oneAtATime(repo.root, () =>
    ports.fastForwardBase(repo, base, config.remote),
  ).catch(() => false);
  if (!updated) {
    log.event('base.behind', { base }, 'quiet');
  }
}

export function stop(job: Run): IssueReport {
  job.log.event('issue.stop', { phase: job.state.phase }, 'quiet');
  return jobReport(job, 'stopped');
}

export function stopNow(
  log: Recorder,
  issue: Issue,
  state: IssueState,
  started: number,
): IssueReport {
  log.event('issue.stop', { phase: state.phase }, 'quiet');
  return issueReport(issue.number, 'stopped', state, started);
}

function jobReport(job: Run, outcome: Outcome, reason?: string): IssueReport {
  return issueReport(job.issue.number, outcome, job.state, job.started, reason);
}

function issueReport(
  issue: number,
  outcome: Outcome,
  state: IssueState,
  started: number,
  reason?: string,
): IssueReport {
  return {
    issue,
    outcome,
    reason,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: elapsedMs(started),
  };
}

export async function finish(job: Run, outcome: Outcome, reason?: string): Promise<IssueReport> {
  const { context, issue, log, branch } = job;
  const { repo } = context;
  await cleanUp(context, log, branch);
  if (outcome === 'done') {
    await deleteBranches(context, log, branch);
    await dropState(repo, issue.number);
  }
  return {
    ...jobReport(job, outcome, reason),
    ...(job.mainBroken && outcome !== 'done' ? { halt: true } : {}),
  };
}

async function deleteBranches(context: Context, log: Recorder, branch: string): Promise<void> {
  const { repo, ports } = context;
  for (const name of [branch, ...(await ports.disputeBranches(repo, branch))]) {
    await removeOrKeep(context, log, 'branch.kept', { branch: name }, () =>
      ports.deleteBranch(repo, name),
    );
  }
}

async function removeOrKeep(
  context: Context,
  log: Recorder,
  kind: string,
  fields: Fields,
  remove: () => Promise<boolean>,
): Promise<void> {
  if (!(await oneAtATime(context.repo.root, remove))) {
    log.event(kind, fields, 'quiet');
  }
}

async function cleanUp(context: Context, log: Recorder, branch: string): Promise<void> {
  const { repo, ports } = context;
  try {
    const path = await ports.findWorktree(repo, branch);
    if (path === undefined) {
      return;
    }
    await removeOrKeep(context, log, 'worktree.kept', { path }, () =>
      ports.removeWorktree(repo, path),
    );
  } catch (error) {
    log.event('worktree.error', { error: message(error) }, 'quiet');
  }
}

async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
): Promise<void> {
  const { repo, ports, config } = context;
  log.event('hand-over', { reason }, 'quiet');
  await writeState(repo, { ...state, handedOver: true });
  await setStatus(context, issue, config.labels.needsHuman);
  await ports.commentOnIssue(repo, issue, handOverComment(reason));
}

const COMMENT_LIMIT = 65536;
const CUT = '\n\nThe reason was too long for a GitHub comment and was cut.';

function handOverComment(reason: string): string {
  const comment = `${HAND_OVER} ${reason}`;
  if (comment.length <= COMMENT_LIMIT) {
    return comment;
  }
  const end = COMMENT_LIMIT - CUT.length;
  const splitsPair = /[\uD800-\uDBFF]/.test(comment.charAt(end - 1));
  return `${comment.slice(0, splitsPair ? end - 1 : end)}${CUT}`;
}

export async function claimedError(
  context: Context,
  log: Recorder,
  issue: Issue,
  state: IssueState,
  error: unknown,
  started: number,
): Promise<IssueReport> {
  const { reason } = logIssueError(log, error, started);
  try {
    await handOver(context, log, issue.number, state, `The run failed: ${reason}`);
  } catch (failure) {
    log.event('hand-over.error', { error: message(failure) }, 'quiet');
  }
  await cleanUp(context, log, state.branch);
  return issueReport(issue.number, 'error', state, started, reason);
}
