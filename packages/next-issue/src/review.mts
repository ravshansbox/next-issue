import { REVIEWING } from './agents.mts';
import { budgetUse, spendBudget } from './budget.mts';
import { fixRound, type Unfixed } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { ROUND_CONTINUE, type Round, type Run, runRole, setStatus } from './job.mts';
import { landApproved } from './land.mts';
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
  const exhausted = await spendBudget(
    job,
    'reviewRounds',
    `The limit of ${config.maxReviewRounds} review rounds was reached.`,
    'review budget',
  );
  if (exhausted) {
    return exhausted;
  }

  await setStatus(context, issue.number, config.labels.inReview);
  const earlier = history(state.reviewLog);
  const verdict = parseVerdict(await runReviewer(job, earlier));
  if (verdict === undefined) {
    return escalateAndFinish(job, 'The reviewer gave no verdict.', 'no verdict');
  }
  const { round, limit } = budgetUse(job, 'reviewRounds');
  const open = openFindings(verdict, round >= limit);
  recordVerdict(job, verdict, open);
  await ports.commentOnIssue(repo, issue.number, formatVerdict(verdict, open));

  if (open.length === 0) {
    return landApproved(job);
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
    ...budgetUse(job, 'reviewRounds'),
    diffChars: full.length,
    cut: full.length > config.diffMaxChars,
  };
  const before = await ports.revision(worktree);
  const review = await log.step('review', fields, () =>
    runRole(
      job,
      'reviewer',
      reviewPrompt(
        issue,
        comments,
        patch,
        earlier,
        earlier.length === 0 ? state.implementerReply : state.fixerReply,
      ),
      REVIEWING,
    ),
  );
  if (await ports.discardChanges(worktree, before, job.branch)) {
    log.event('review.discard', { round: state.reviewRounds }, 'quiet');
  }
  return review.text;
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
      `The fixer ${fix.unrelated === undefined ? 'settled' : 'disputed'} the findings and left a change behind: ${note}`,
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
  await ports.commentOnIssue(repo, issue.number, `### Fixer: ${heading}\n\n${note}`);
  return ROUND_CONTINUE;
}
