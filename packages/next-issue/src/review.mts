import { REVIEWING } from './agents.mts';
import { conflicts, resolveConflict } from './conflict.mts';
import { fixRound, type Unfixed } from './fix.mts';
import { checkGate } from './gate.mts';
import { escalateAndFinish, finishDone } from './handover.mts';
import { gateRound, ROUND_CONTINUE, type Round, type Run, runRole, setStatus } from './job.mts';
import { afterMerge } from './merge.mts';
import { capDiff, history, reviewPrompt } from './prompts.mts';
import { writeState } from './state.mts';
import {
  blockingFindings,
  type Finding,
  formatFindings,
  formatVerdict,
  openFindings,
  parseVerdict,
  type Verdict,
} from './verdict.mts';

export async function reviewRound(job: Run): Promise<Round> {
  const { context, issue, state } = job;
  const { repo, config, ports } = context;
  const pr = state.pr!;
  if (state.reviewRounds >= config.maxReviewRounds) {
    return escalateAndFinish(
      job,
      `The limit of ${config.maxReviewRounds} review rounds was reached.`,
      'review budget',
    );
  }
  state.reviewRounds += 1;
  await writeState(repo, state);

  await setStatus(context, issue.number, pr, config.labels.inReview);
  const earlier = history(state.reviewLog);
  const verdict = parseVerdict(await runReviewer(job, earlier));
  if (verdict === undefined) {
    return escalateAndFinish(job, 'The reviewer gave no verdict.', 'no verdict');
  }
  const open = openFindings(verdict, state.reviewRounds >= config.maxReviewRounds);
  recordVerdict(job, verdict, open);
  await ports.commentOnPr(repo, pr, formatVerdict(verdict, open));

  if (open.length === 0) {
    return approvedRound(job);
  }
  return changesRequestedRound(job, open, earlier);
}

async function changesRequestedRound(job: Run, open: Finding[], earlier: string[]): Promise<Round> {
  const { state } = job;
  const findings = formatFindings(open);
  state.reviewLog.push({ round: state.reviewRounds, findings });
  await writeState(job.context.repo, state);

  const fix = await fixRound(job, 'The reviewer requested changes.', findings, earlier, 'review');
  if (!fix.committed) {
    return unfixedRound(job, fix);
  }
  return ROUND_CONTINUE;
}

function recordVerdict(job: Run, verdict: Verdict, open: Finding[]): void {
  const blocking = blockingFindings(verdict);
  job.log.event(
    'verdict',
    {
      round: job.state.reviewRounds,
      blocking: blocking.length,
      minor: verdict.findings.length - blocking.length,
      open: open.length,
      summary: verdict.summary,
    },
    'quiet',
  );
}

async function runReviewer(job: Run, earlier: string[]): Promise<string> {
  const { context, issue, log, state, worktree, comments } = job;
  const { config, ports } = context;
  const full = await ports.diff(worktree, context.base, config.remote);
  const patch = capDiff(full, config.diffMaxChars);
  const fields = {
    round: state.reviewRounds,
    limit: config.maxReviewRounds,
    diffChars: full.length,
    cut: full.length > config.diffMaxChars,
  };
  const before = await ports.revision(worktree);
  const review = await log.step('review', fields, () =>
    runRole(job, 'reviewer', reviewPrompt(issue, comments, patch, earlier), REVIEWING),
  );
  if (await ports.discardChanges(worktree, before)) {
    log.event('review.discard', { round: state.reviewRounds }, 'quiet');
  }
  return review.text;
}

async function unfixedRound(job: Run, fix: Unfixed): Promise<Round> {
  const { context, state } = job;
  const { repo, ports } = context;
  const note = fix.unrelated;
  if (note === undefined) {
    return escalateAndFinish(
      job,
      'The fixer added no commit for the review findings.',
      'no fix commit',
    );
  }
  if (fix.stray === true) {
    return escalateAndFinish(
      job,
      `The fixer disputed the findings and left a change behind: ${note}`,
      'dispute with changes',
    );
  }
  state.reviewLog.at(-1)!.dispute = note;
  await writeState(repo, state);
  await ports.commentOnPr(repo, state.pr!, `### Fixer: no change\n\n${note}`);
  return ROUND_CONTINUE;
}

async function approvedRound(job: Run): Promise<Round> {
  const { context, log, state } = job;
  const { repo, config, ports } = context;
  const pr = state.pr!;
  const round = gateRound(await checkGate(job));
  if (round) {
    return round;
  }
  if (config.draftPullRequest && !(await ports.markPrReady(repo, pr))) {
    log.event('pull-request.undraft.fail', { pr }, 'quiet');
  }
  if (context.merge) {
    return mergeApproved(job);
  }
  return finishDone(job);
}

async function mergeApproved(job: Run): Promise<Round> {
  const { context, state } = job;
  if (await conflicts(job)) {
    const resolved = await resolveConflict(job);
    return resolved.done ? resolved : ROUND_CONTINUE;
  }
  if (!(await context.ports.mergePr(context.repo, state.pr!))) {
    return escalateAndFinish(job, 'The merge of the pull request failed.', 'merge failed');
  }
  return afterMerge(job);
}
