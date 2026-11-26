import { runStopped } from './children.mts';
import { elapsedMs } from './durations.mts';
import { message } from './errors.mts';
import type { Issue } from './github.mts';
import { HAND_OVER, threadEnd } from './hand-over-comments.mts';
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
import { dropState, type IssueState, type PendingHandOver, writeState } from './state.mts';
import { COMMENT_CUT, fitComment } from './text.mts';
import { blocksLanding, heldOnBase, UnsettledBase } from './unsettled.mts';

export async function escalateAndFinish(job: Run, note: string, reason: string): Promise<Finished> {
  const reverted = await revertFailedFix(job);
  try {
    await handOver(
      job.context,
      job.log,
      job.issue.number,
      job.state,
      `${note}${savedIn(job.asides)}${reverted}`,
    );
  } catch (error) {
    if (!job.mainBroken || runStopped()) {
      throw error;
    }
    const failure = message(error);
    job.log.event('hand-over.error', { reason, error: failure });
    return {
      done: true,
      report: await finish(job, 'error', `${reason}; the hand-over failed: ${failure}`),
    };
  }
  return { done: true, report: await finish(job, 'needs-human', reason) };
}

function savedIn(asides: string[]): string {
  const branches = asides.map((aside) => `\`${aside}\``);
  if (branches.length < 2) {
    return branches.length === 0
      ? ''
      : ` The fixer left a change behind; it is saved in the branch ${branches[0]}.`;
  }
  return ` The fixer left changes behind; they are saved in the branches ${branches.slice(0, -1).join(', ')} and ${branches.at(-1)}.`;
}

export async function finishDone(job: Run, note?: string): Promise<Finished> {
  const { context, issue } = job;
  if (issue.closed !== true) {
    const { state } = job;
    state.closing = true;
    if (note !== undefined && state.donePosted !== true) {
      state.doneNote = note;
    }
    await writeState(context.repo, state);
    if (state.doneNote !== undefined) {
      await context.ports.commentOnIssue(
        context.repo,
        issue.number,
        fitComment(state.doneNote, COMMENT_CUT),
      );
      state.donePosted = true;
      delete state.doneNote;
      await writeState(context.repo, state);
    }
    await setStatus(context, issue.number, context.config.labels.done);
    await context.ports.closeIssue(context.repo, issue.number);
  }
  return { done: true, report: await finish(job, 'done') };
}

export async function finishClosing(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  started: number,
): Promise<IssueReport> {
  const job: Run = {
    context,
    issue,
    log,
    state,
    branch: state.branch,
    worktree: '',
    comments: [],
    reply: [],
    started,
    mainBroken: false,
    repairing: false,
    handedOver: false,
    asides: [],
  };
  return (await finishDone(job)).report;
}

export async function dropClosed(
  context: Context,
  log: Recorder,
  issue: Issue,
  saved: IssueState | undefined,
): Promise<IssueReport> {
  log.event('issue.drop', { title: issue.title, reason: 'closed' });
  if (saved !== undefined && blocksLanding(saved, context.base)) {
    log.event('land.released', { held: heldOnBase(saved, context.base), reason: 'closed' });
  }
  try {
    if (openedOwnWorktree(saved)) {
      await cleanUp(context, log, issue.number, saved.branch);
      await deleteBranches(context, log, saved);
    }
    await dropState(context.repo, issue.number);
  } catch (error) {
    log.event('drop.error', { error: message(error) });
  }
  return {
    issue: issue.number,
    outcome: 'skipped',
    reason: 'closed',
    ciFixes: 0,
    reviewRounds: 0,
    ms: 0,
  };
}

export function stop(job: Run, reason?: string): IssueReport {
  job.log.event('issue.stop', { phase: job.state.phase, reason });
  return jobReport(job, 'stopped', reason);
}

export function stopNow(
  log: Recorder,
  issue: Issue,
  state: IssueState,
  started: number,
): IssueReport {
  log.event('issue.stop', { phase: state.phase });
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
  await cleanUp(context, log, issue.number, branch);
  if (outcome === 'done') {
    await deleteBranches(context, log, job.state);
    await dropState(repo, issue.number);
  }
  const halt = job.mainBroken && outcome !== 'done';
  if (halt) {
    context.halted = true;
  }
  return {
    ...jobReport(job, outcome, reason),
    ...(halt ? { halt: true } : {}),
  };
}

async function deleteBranches(context: Context, log: Recorder, state: IssueState): Promise<void> {
  const { repo, ports, config } = context;
  const { branch } = state;
  await removeOrKeep(context, log, 'branch.remote-kept', { branch }, () =>
    ports.deleteRemoteBranch(repo, config.remote, branch, state.branchHead ?? ''),
  );
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
    log.event(kind, fields);
  }
}

function openedOwnWorktree(state: IssueState | undefined): state is IssueState {
  return state !== undefined && state.fresh !== true;
}

async function cleanUp(
  context: Context,
  log: Recorder,
  issue: number,
  branch: string,
): Promise<void> {
  const { repo, ports } = context;
  try {
    const path = await ports.findWorktree(repo, issue, branch);
    if (path === undefined) {
      return;
    }
    await removeOrKeep(context, log, 'worktree.kept', { path }, () =>
      ports.removeWorktree(repo, path),
    );
  } catch (error) {
    log.event('worktree.error', { error: message(error) });
  }
}

async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
  earlier?: PendingHandOver,
): Promise<void> {
  const { repo, ports, config } = context;
  log.event('hand-over', { reason });
  const { pendingHandOver: _pending, ...rest } = state;
  const { closing: _closing, ...taken } = rest;
  let pending: PendingHandOver | undefined = earlier;
  try {
    const since = earlier?.since ?? (await threadEnd(context, issue));
    pending = { ...earlier, reason, ...(since === undefined ? {} : { since }) };
    await writeState(repo, { ...rest, pendingHandOver: pending });
    if (config.labels.ready.length > 0) {
      await ports.setLabel(repo, issue, config.labels.ready, []);
    }
    await setStatus(context, issue, config.labels.needsHuman, [config.labels.ready]);
    pending = { ...pending, labelled: true };
    await writeState(repo, { ...taken, pendingHandOver: pending });
    await ports.commentOnIssue(repo, issue, handOverComment(reason));
  } catch (error) {
    throw new HandOverFailed(reason, error, pending);
  }
  await writeState(repo, { ...taken, handedOver: true });
}

class HandOverFailed extends Error {
  readonly reason: string;
  readonly pending: PendingHandOver | undefined;

  constructor(reason: string, cause: unknown, pending: PendingHandOver | undefined) {
    super(message(cause), { cause });
    this.reason = reason;
    this.pending = pending;
  }
}

function handOverReason(error: unknown, reason: string): string {
  if (error instanceof HandOverFailed) {
    return error.reason;
  }
  const unsettled = error instanceof UnsettledBase ? error.note : '';
  return `The run failed: ${reason}${unsettled}`;
}

function handOverComment(reason: string): string {
  return fitComment(`${HAND_OVER}\n\n${reason}`, COMMENT_CUT);
}

export async function claimedError(
  context: Context,
  log: Recorder,
  issue: Issue,
  state: IssueState,
  error: unknown,
  started: number,
): Promise<IssueReport> {
  const reason = message(error);
  if (error instanceof UnsettledBase) {
    state.halted = true;
  }
  let handedOver = false;
  try {
    const earlier = error instanceof HandOverFailed ? error.pending : undefined;
    await handOver(context, log, issue.number, state, handOverReason(error, reason), earlier);
    handedOver = true;
  } catch (failure) {
    log.event('hand-over.error', { error: message(failure) });
  }
  logIssueError(log, error, started);
  if (openedOwnWorktree(state)) {
    await cleanUp(context, log, issue.number, state.branch);
  }
  const report = {
    ...issueReport(issue.number, 'error', state, started, reason),
    ...(handedOver ? { handedOver } : {}),
  };
  if (!(error instanceof UnsettledBase)) {
    return report;
  }
  context.halted = true;
  return { ...report, halt: true };
}
