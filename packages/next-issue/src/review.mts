import { REVIEWING } from './agents.mts';
import { conflicts, resolveConflict } from './conflict.mts';
import { type Fix, fixRound } from './fix.mts';
import { checkGate } from './gate.mts';
import { escalateAndFinish, finishDone } from './handover.mts';
import { history, type Round, type Run, runRole, setStatus } from './job.mts';
import { afterMerge } from './merge.mts';
import { capDiff, reviewPrompt } from './prompts.mts';
import { writeState } from './state.mts';
import {
  blockingFindings,
  formatFindings,
  formatVerdict,
  openFindings,
  parseVerdict,
} from './verdict.mts';

export async function reviewRound(job: Run): Promise<Round> {
  const { context, issue, log, state, worktree, comments } = job;
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
  const full = await ports.diff(worktree, context.base, config.remote);
  const patch = capDiff(full, config.diffMaxChars);
  const fields = {
    round: state.reviewRounds,
    limit: config.maxReviewRounds,
    diffChars: full.length,
    cut: full.length > config.diffMaxChars,
  };
  const earlier = history(state.reviewLog);
  const before = await ports.revision(worktree);
  const review = await log.step('review', fields, () =>
    runRole(job, 'reviewer', reviewPrompt(issue, comments, patch, earlier), REVIEWING),
  );
  if (await ports.discardChanges(worktree, before)) {
    log.event('review.discard', { round: state.reviewRounds }, 'quiet');
  }
  const verdict = parseVerdict(review.text);
  if (verdict === undefined) {
    return escalateAndFinish(job, 'The reviewer gave no verdict.', 'no verdict');
  }
  const blocking = blockingFindings(verdict);
  const open = openFindings(verdict, state.reviewRounds >= config.maxReviewRounds);
  log.event(
    'verdict',
    {
      round: state.reviewRounds,
      blocking: blocking.length,
      minor: verdict.findings.length - blocking.length,
      open: open.length,
      summary: verdict.summary,
    },
    'quiet',
  );
  await ports.commentOnPr(repo, pr, formatVerdict(verdict, open));

  if (open.length === 0) {
    return approvedRound(job);
  }

  const findings = formatFindings(open);
  state.reviewLog.push({ round: state.reviewRounds, findings });
  await writeState(repo, state);

  const fix = await fixRound(job, 'The reviewer requested changes.', findings, earlier, 'review');
  if (!fix.committed) {
    return unfixedRound(job, fix);
  }
  return { done: false };
}

async function unfixedRound(job: Run, fix: Extract<Fix, { committed: false }>): Promise<Round> {
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
  return { done: false };
}

async function approvedRound(job: Run): Promise<Round> {
  const { context, log, state } = job;
  const { repo, config, ports } = context;
  const pr = state.pr!;
  const gate = await checkGate(job);
  if (gate.done) {
    return gate;
  }
  if (gate.fixed) {
    return { done: false };
  }
  if (config.draftPullRequest && !(await ports.markPrReady(repo, pr))) {
    log.event('pull-request.undraft.fail', { pr }, 'quiet');
  }
  if (context.merge) {
    if (await conflicts(job)) {
      const resolved = await resolveConflict(job);
      return resolved.done ? resolved : { done: false };
    }
    if (!(await ports.mergePr(repo, pr))) {
      return escalateAndFinish(job, 'The merge of the pull request failed.', 'merge failed');
    }
    return afterMerge(job);
  }
  return { done: true, report: await finishDone(job) };
}
