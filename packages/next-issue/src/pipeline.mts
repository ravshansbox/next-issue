import { CODING } from './agents.mts';
import { type Config, minutesToMs } from './config.mts';
import { commitWork } from './fix.mts';
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
import {
  type Context,
  fallbackTitle,
  type IssueReport,
  oneAtATime,
  openPr,
  type Round,
  type Run,
  runRole,
  setStatus,
} from './job.mts';
import { afterMerge, fixBase } from './merge.mts';
import { message, type Recorder } from './observe.mts';
import { implementPrompt, parseCommitSubject } from './prompts.mts';
import { reviewRound } from './review.mts';
import { type IssueState, readState, resetState, savedIssues, writeState } from './state.mts';

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

export async function pendingIssues(context: Context): Promise<Issue[]> {
  const { repo, config, ports } = context;
  const { ready, inProgress, inReview } = config.labels;
  const labels = ready.length === 0 ? [] : [ready, inProgress, inReview];
  const issues = await ports.openIssues(repo, config.issueLimit, labels);
  const listed = new Set(issues.map((issue) => issue.number));
  let openCount = issues.length;
  for (const number of await savedIssues(repo)) {
    if (listed.has(number)) {
      continue;
    }
    const saved = await readState(repo, number).catch(() => 'broken' as const);
    if (saved === undefined) {
      continue;
    }
    try {
      const { open, ...issue } = await ports.viewIssue(repo, number);
      if (open) {
        openCount += 1;
      }
      if (
        saved === 'broken' ||
        open ||
        (saved.pr !== undefined && (await ports.prMerged(repo, saved.pr)))
      ) {
        issues.push(issue);
      }
    } catch (error) {
      context.recorder
        .scope({ issue: number })
        .event('issue.error', { error: message(error) }, 'quiet');
    }
  }
  context.recorder.event('issues', { open: openCount }, 'quiet');
  return issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function processIssue(context: Context, issue: Issue): Promise<IssueReport> {
  const { repo, config, ports } = context;
  const started = Date.now();
  const log = context.recorder.scope({ issue: issue.number });
  let saved: IssueState | undefined;
  try {
    saved = await readState(repo, issue.number);
  } catch (error) {
    return unclaimedError(log, issue, error, started);
  }
  const skip = skipReason(issue, config, saved !== undefined);
  if (skip !== undefined) {
    log.event('issue.skip', { title: issue.title, reason: skip });
    return skipped(issue);
  }
  if (saved === undefined) {
    let blockers: string[];
    try {
      blockers = await ports.openBlockers(repo, issue.number);
    } catch (error) {
      return unclaimedError(log, issue, error, started);
    }
    if (blockers.length > 0) {
      log.event('issue.skip', { title: issue.title, reason: 'blocked', blockers });
      return skipped(issue);
    }
  }
  log.event('issue.start', { title: issue.title, createdAt: issue.createdAt }, 'quiet');

  const fresh: IssueState = {
    issue: issue.number,
    phase: 'claimed',
    branch: branchName(issue.number),
    ciFixes: 0,
    reviewRounds: 0,
    reviewLog: [],
  };
  const state =
    saved === undefined
      ? fresh
      : context.reset || saved.handedOver === true
        ? resetState(saved)
        : saved;

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
  const late = setup.timedOut === true;
  log.event(
    'setup.fail',
    { code: setup.code, timedOut: late, stderr: setup.stderr.trim().slice(-2000) },
    'quiet',
  );
  return escalateAndFinish(
    job,
    late
      ? `The setup command did not finish in ${config.setupTimeoutMinutes} minutes.`
      : 'The setup command failed in the worktree.',
    late ? 'setup timeout' : 'setup failed',
  );
}

async function implement(job: Run): Promise<Round> {
  const { context, issue, log, state, worktree, comments, reply } = job;
  const { repo, config, ports } = context;
  const before = await ports.revision(worktree);
  const result = await log.step('implement', {}, () =>
    runRole(job, 'implementer', implementPrompt(issue, comments, reply), CODING),
  );
  const subject = parseCommitSubject(result.text, fallbackTitle(issue));
  if (!(await commitWork(job, before, subject, 'implementer'))) {
    const earlier = await ports.latestSubject(worktree, context.base, config.remote);
    if (earlier === undefined) {
      return escalateAndFinish(
        job,
        'The implementer produced no change.',
        'no implementation commit',
      );
    }
    log.event('implement.earlier', { subject: earlier }, 'quiet');
    state.title = earlier;
  }
  state.phase = 'implemented';
  await writeState(repo, state);
  return { done: false };
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
    log.event('pull-request.merged', { pr: state.pr }, 'quiet');
    if (!context.merge) {
      return { done: true, report: await finishDone(job) };
    }
    return afterMerge(job);
  }
  await log.step('push', { branch }, () => ports.push(worktree, config.remote, branch));
  state.phase = 'review';
  await openPr(job);
  return { done: false };
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
