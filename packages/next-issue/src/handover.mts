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
import { logIssueError } from './skip.mts';
import { dropState, type IssueState, writeState } from './state.mts';

export async function escalateAndFinish(job: Run, note: string, reason: string): Promise<Finished> {
  await handOver(job.context, job.log, job.issue.number, job.state, note);
  return { done: true, report: await finish(job, 'needs-human', reason) };
}

export function escalateCheckFix(
  job: Run,
  unrelated: string | undefined,
  checks: string,
): Promise<Finished> {
  if (unrelated === undefined) {
    return escalateAndFinish(
      job,
      `The fixer added no commit for the failed ${checks}.`,
      'no fix commit',
    );
  }
  return escalateAndFinish(
    job,
    `The ${checks} fail for a reason this change did not cause: ${unrelated}`,
    'unrelated failure',
  );
}

export async function finishDone(job: Run): Promise<Finished> {
  const { context, issue, state } = job;
  await setStatus(context, issue.number, state.pr, context.config.labels.done);
  return { done: true, report: await finish(job, 'done') };
}

export function stop(job: Run): IssueReport {
  job.log.event('issue.stop', { phase: job.state.phase }, 'quiet');
  return jobReport(job, 'stopped');
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
    pr: state.pr,
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
  await setStatus(context, issue, state.pr, config.labels.needsHuman);
  const body = `${HAND_OVER} ${reason}`;
  if (state.pr === undefined) {
    await ports.commentOnIssue(repo, issue, body);
  } else {
    await ports.commentOnPr(repo, state.pr, body);
  }
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
