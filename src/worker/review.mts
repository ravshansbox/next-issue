import { REVIEWING } from '../shared/agents.mts';
import { runStopped } from '../shared/children.mts';
import { budgetUse, refundIfCut, spendBudget } from './budget.mts';
import { message } from '../shared/errors.mts';
import { fixRound, type Unfixed } from './fix.mts';
import { escalateAndFinish } from '../shared/handover.mts';
import { ROUND_CONTINUE, type Round, type Run, runRole, setStatus } from '../shared/job.mts';
import { landApproved } from './land.mts';
import { capDiff, history, reviewPrompt } from '../shared/prompts.mts';
import { writeState } from '../shared/state.mts';
import { agentHeading, COMMENT_CUT, fitComment } from '../shared/text.mts';
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
  const exhausted = await spendBudget(
    job,
    'reviewRounds',
    `The limit of ${config.maxReviewRounds} review rounds was reached.`,
    'review budget',
  );
  if (exhausted) {
    return exhausted;
  }

  const earlier = history(state.reviewLog);
  const open = await refundIfCut(job, 'reviewRounds', async () => {
    await setStatus(context, issue.number, config.labels.inReview);
    const verdict = parseVerdict(await runReviewer(job, earlier));
    if (verdict === undefined) {
      return undefined;
    }
    const { round, limit } = budgetUse(job, 'reviewRounds');
    const findings = openFindings(verdict, round >= limit);
    recordVerdict(job, verdict, findings);
    await ports.commentOnIssue(
      repo,
      issue.number,
      fitComment(formatVerdict(verdict, findings), COMMENT_CUT),
    );
    return findings;
  });
  if (open === undefined) {
    return escalateAndFinish(job, 'The reviewer gave no verdict.', 'no verdict');
  }

  if (open.length === 0) {
    state.phase = 'approved';
    await writeState(repo, state);
    return landApproved(job);
  }
  return changesRequestedRound(job, open, earlier);
}

async function changesRequestedRound(job: Run, open: Finding[], earlier: string[]): Promise<Round> {
  const { state } = job;
  const findings = formatFindings(open);
  state.reviewLog.push({ round: state.reviewRounds, findings });
  await writeState(job.context.repo, state);

  const fix = await refundIfCut(
    job,
    'reviewRounds',
    () => fixRound(job, 'The reviewer requested changes.', findings, earlier, 'review'),
    () => {
      state.reviewLog.pop();
    },
  );
  if (!fix.committed) {
    return unfixedRound(job, fix);
  }
  return ROUND_CONTINUE;
}

function recordVerdict(job: Run, verdict: Verdict, open: Finding[]): void {
  const blocking = blockingFindings(verdict);
  job.log.event('verdict', {
    round: job.state.reviewRounds,
    blocking: blocking.length,
    minor: verdict.findings.length - blocking.length,
    open: open.length,
    summary: verdict.summary,
  });
}

async function runReviewer(job: Run, earlier: string[]): Promise<string> {
  const { context, issue, log, state, worktree, comments } = job;
  const { config, ports } = context;
  const before = await ports.revision(worktree);
  state.reviewing = before;
  await writeState(context.repo, state);
  if (await ports.discardChanges(worktree, before, job.branch)) {
    log.event('review.clean', { round: state.reviewRounds });
  }
  const full = await ports.diff(worktree, context.base, config.remote);
  const patch = capDiff(full, config.diffMaxChars);
  const fields = {
    ...budgetUse(job, 'reviewRounds'),
    diffChars: full.length,
    cut: full.length > config.diffMaxChars,
  };
  const review = await undoingReview(job, before, () =>
    log.step('review', fields, () =>
      runRole(
        job,
        'reviewer',
        reviewPrompt(
          issue,
          comments,
          patch,
          earlier,
          state.fixerReply === undefined ? 'implementer' : 'fixer',
          state.fixerReply ?? state.implementerReply,
        ),
        REVIEWING,
      ),
    ),
  );
  return review.text;
}

export async function undoingReview<T>(
  job: Run,
  before: string,
  review: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await review();
  } catch (error) {
    if (!runStopped()) {
      await undoReview(job, before).catch((cleanup: unknown) => {
        job.log.event('review.discard.error', { error: message(cleanup) });
      });
    }
    throw error;
  }
  if (!runStopped()) {
    await undoReview(job, before);
  }
  return result;
}

export async function settleReview(job: Run): Promise<void> {
  if (job.state.reviewing !== undefined) {
    await undoReview(job, job.state.reviewing);
  }
}

async function undoReview(job: Run, before: string): Promise<void> {
  const { context, log, state, worktree } = job;
  if (await context.ports.discardChanges(worktree, before, job.branch)) {
    log.event('review.discard', { round: state.reviewRounds });
  }
  state.reviewing = undefined;
  await writeState(context.repo, state);
}

async function unfixedRound(job: Run, fix: Unfixed): Promise<Round> {
  const { context, issue, state } = job;
  const { repo, ports } = context;
  const note = fix.unrelated ?? fix.resolved;
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
      `The fixer ${fix.unrelated === undefined ? 'settled' : 'disputed'} the findings: ${note}`,
      'dispute with changes',
    );
  }
  const round = state.reviewLog.at(-1)!;
  if (fix.unrelated === undefined) {
    round.settled = note;
  } else {
    round.dispute = note;
  }
  await writeState(repo, state);
  const heading = fix.unrelated === undefined ? 'settled with no change' : 'no change';
  await ports.commentOnIssue(
    repo,
    issue.number,
    fitComment(`${agentHeading('Fixer', heading)}\n\n${note}`, COMMENT_CUT),
  );
  return ROUND_CONTINUE;
}
