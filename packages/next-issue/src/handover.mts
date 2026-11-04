import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import type { Issue } from './github.mts';
import { HAND_OVER } from './hand-over-comments.mts';
import {
  type Context,
  type Finished,
  type IssueReport,
  type Outcome,
  oneAtATime,
  type Run,
  setStatus,
} from './job.mts';
import type { Recorder } from './observe.mts';
import { dropState, type IssueState, writeState } from './state.mts';

export async function escalateAndFinish(job: Run, note: string, reason: string): Promise<Finished> {
  await handOver(job.context, job.log, job.issue.number, job.state, note);
  return { done: true, report: await finish(job, 'needs-human', reason) };
}

export async function spendCiFix(
  job: Run,
  note: string,
  reason: string,
): Promise<Finished | undefined> {
  const { context, state } = job;
  if (state.ciFixes >= context.config.maxCiFixes) {
    return escalateAndFinish(job, note, reason);
  }
  state.ciFixes += 1;
  await writeState(context.repo, state);
  return undefined;
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

export async function finishDone(job: Run): Promise<IssueReport> {
  const { context, issue, state } = job;
  await setStatus(context, issue.number, state.pr, context.config.labels.done);
  return finish(job, 'done');
}

export function stop(job: Run): IssueReport {
  const { issue, log, state } = job;
  log.event('issue.stop', { phase: state.phase }, 'quiet');
  return {
    issue: issue.number,
    outcome: 'stopped',
    ...progress(job.state, job.started),
  };
}

export function progress(
  state: IssueState,
  started: number,
): Pick<IssueReport, 'pr' | 'ciFixes' | 'reviewRounds' | 'ms'> {
  return {
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
    issue: issue.number,
    outcome,
    reason,
    ...progress(job.state, job.started),
    ...(job.mainBroken && outcome !== 'done' ? { halt: true } : {}),
  };
}

async function deleteBranches(context: Context, log: Recorder, branch: string): Promise<void> {
  const { repo, ports } = context;
  for (const name of [branch, ...(await ports.disputeBranches(repo, branch))]) {
    if (!(await oneAtATime(repo.root, () => ports.deleteBranch(repo, name)))) {
      log.event('branch.kept', { branch: name }, 'quiet');
    }
  }
}

export async function cleanUp(context: Context, log: Recorder, branch: string): Promise<void> {
  const { repo, ports } = context;
  try {
    const path = await ports.findWorktree(repo, branch);
    if (path === undefined) {
      return;
    }
    if (!(await oneAtATime(repo.root, () => ports.removeWorktree(repo, path)))) {
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

export function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
