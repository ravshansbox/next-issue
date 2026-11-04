import { type Config, minutesToMs } from './config.mts';
import { checkGate } from './gate.mts';
import { branchName } from './git.mts';
import type { Issue } from './github.mts';
import {
  cleanUp,
  escalateAndFinish,
  finishDone,
  handOver,
  handOverReply,
  skipped,
  stop,
  writerComments,
} from './handover.mts';
import { implement } from './implement.mts';
import {
  type Context,
  type IssueReport,
  oneAtATime,
  openPr,
  type Round,
  type Run,
  setStatus,
} from './job.mts';
import { afterMerge, fixBase } from './merge.mts';
import { message, type Recorder } from './observe.mts';
import { reviewRound } from './review.mts';
import { type IssueState, readState, resetState, writeState } from './state.mts';

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

async function skipReport(
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

function startState(context: Context, issue: Issue, saved: IssueState | undefined): IssueState {
  if (saved === undefined) {
    return {
      issue: issue.number,
      phase: 'claimed',
      branch: branchName(issue.number),
      ciFixes: 0,
      reviewRounds: 0,
      reviewLog: [],
    };
  }
  return context.reset || saved.handedOver === true ? resetState(saved) : saved;
}

async function claimedError(
  context: Context,
  log: Recorder,
  issue: Issue,
  state: IssueState,
  error: unknown,
  started: number,
): Promise<IssueReport> {
  log.event('issue.error', { error: message(error), ms: Date.now() - started }, 'quiet');
  try {
    await handOver(context, log, issue.number, state, `The run failed: ${message(error)}`);
  } catch (failure) {
    log.event('hand-over.error', { error: message(failure) }, 'quiet');
  }
  await cleanUp(context, log, state.branch);
  return {
    issue: issue.number,
    outcome: 'error',
    reason: message(error),
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - started,
  };
}

function unclaimedError(log: Recorder, issue: Issue, error: unknown, started: number): IssueReport {
  log.event('issue.error', { error: message(error), ms: Date.now() - started }, 'quiet');
  return {
    ...skipped(issue),
    outcome: 'error',
    reason: message(error),
    ms: Date.now() - started,
  };
}

async function setUp(job: Run): Promise<Round> {
  const { context, log, worktree } = job;
  const { config, ports } = context;
  const setupCommand = config.setupCommand ?? (await ports.detectSetupCommand(worktree));
  if (setupCommand === undefined) {
    return { done: false };
  }
  const setup = await log.step(
    'setup',
    { cmd: setupCommand, found: config.setupCommand === undefined },
    () => ports.runSetup(setupCommand, worktree, minutesToMs(config.setupTimeoutMinutes)),
  );
  if (setup.code === 0) {
    return { done: false };
  }
  return setupFailed(job, setup);
}

async function setupFailed(
  job: Run,
  setup: { code: number; stderr: string; timedOut?: boolean },
): Promise<Round> {
  const late = setup.timedOut === true;
  job.log.event(
    'setup.fail',
    { code: setup.code, timedOut: late, stderr: setup.stderr.trim().slice(-2000) },
    'quiet',
  );
  return escalateAndFinish(
    job,
    late
      ? `The setup command did not finish in ${job.context.config.setupTimeoutMinutes} minutes.`
      : 'The setup command failed in the worktree.',
    late ? 'setup timeout' : 'setup failed',
  );
}

async function enterReview(job: Run): Promise<Round> {
  const { context, log, state, branch, worktree } = job;
  const { repo, config, ports } = context;
  if (state.baseFix !== undefined) {
    job.mainBroken = true;
    return fixBase(job);
  }
  if (
    state.phase === 'review' &&
    state.pr !== undefined &&
    (await ports.prMerged(repo, state.pr))
  ) {
    return alreadyMerged(job, state.pr);
  }
  await log.step('push', { branch }, () => ports.push(worktree, config.remote, branch));
  state.phase = 'review';
  await openPr(job);
  return { done: false };
}

async function alreadyMerged(job: Run, pr: number): Promise<Round> {
  job.log.event('pull-request.merged', { pr }, 'quiet');
  if (!job.context.merge) {
    return { done: true, report: await finishDone(job) };
  }
  return afterMerge(job);
}

async function openJob(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  start: boolean,
  handedOver: boolean,
): Promise<Run> {
  const started = Date.now();
  const { repo, config } = context;
  const branch = state.branch;

  await log.step('claim', { label: config.labels.inProgress }, async () => {
    await setStatus(context, issue.number, state.pr, config.labels.inProgress);
    await writeState(repo, state);
  });

  const comments = await log.step('comments', {}, () => writerComments(context, log, issue.number));
  const reply = handedOver
    ? await log.step('reply', {}, () => handOverReply(context, issue.number, state.pr))
    : [];
  const worktree = await openWorktree(context, issue, log, branch, start);
  return {
    context,
    issue,
    log,
    state,
    branch,
    worktree,
    comments,
    reply,
    started,
    noChecks: false,
    mainBroken: false,
  };
}

async function openWorktree(
  context: Context,
  issue: Issue,
  log: Recorder,
  branch: string,
  start: boolean,
): Promise<string> {
  const { repo, config, ports } = context;
  const added = await log.step('worktree', { branch }, () =>
    oneAtATime(repo.root, () =>
      ports.addWorktree(repo, issue.number, branch, context.base, config.remote, start),
    ),
  );
  if (!added.baseUpdated) {
    log.event('base.behind', { base: context.base }, 'quiet');
  }
  return added.path;
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
    const gate = await checkGate(job);
    if (gate.done) {
      return gate.report;
    }
    if (gate.fixed) {
      continue;
    }
    if (job.context.stopAfterRound()) {
      return stop(job);
    }
    const round = await reviewRound(job);
    if (round.done) {
      return round.report;
    }
  }
}
