import { REVIEWING } from './agents.mts';
import { conflicts, resolveConflict } from './conflict.mts';
import { fixRound } from './fix.mts';
import { checkGate } from './gate.mts';
import { escalateAndFinish, finish } from './handover.mts';
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
  const before = await ports.revision(worktree);
  const review = await log.step('review', fields, () =>
    runRole(
      job,
      'reviewer',
      reviewPrompt(issue, comments, patch, history(state.reviewLog)),
      REVIEWING,
    ),
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
    const gate = await checkGate(job);
    if (gate.done) {
      return { done: true, report: gate.report };
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
        return resolved.done ? { done: true, report: resolved.report } : { done: false };
      }
      if (!(await ports.mergePr(repo, pr))) {
        return escalateAndFinish(job, 'The merge of the pull request failed.', 'merge failed');
      }
      return afterMerge(job);
    }
    await setStatus(context, issue.number, pr, config.labels.done);
    return { done: true, report: await finish(job, 'done') };
  }

  const earlier = history(state.reviewLog);
  state.reviewLog.push({
    round: state.reviewRounds,
    findings: formatFindings(open),
  });
  await writeState(repo, state);

  const fix = await fixRound(
    job,
    'The reviewer requested changes.',
    formatFindings(open),
    earlier,
    'review',
  );
  if (!fix.committed) {
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
    await ports.commentOnPr(repo, pr, `### Fixer: no change\n\n${note}`);
  }
  return { done: false };
}
