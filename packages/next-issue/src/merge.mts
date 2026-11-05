import { checkPolling, checkWaiting } from './config.mts';
import { conflicts, resolveConflict } from './conflict.mts';
import { fixRound } from './fix.mts';
import { budgetUse } from './budget.mts';
import { escalateAndFinish, escalateCheckFix, finishDone } from './handover.mts';
import {
  type Gate,
  GATE_FIXED,
  GATE_PASSED,
  gateRound,
  openPr,
  ROUND_CONTINUE,
  type Round,
  type Run,
} from './job.mts';
import { writeState } from './state.mts';

export async function mergeApproved(job: Run): Promise<Round> {
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

export async function afterMerge(job: Run): Promise<Round> {
  const round = gateRound(await watchBase(job));
  if (round) {
    return round;
  }
  return finishDone(job);
}

async function watchBase(job: Run): Promise<Gate> {
  const { context, log, state } = job;
  const { repo, config, ports } = context;
  const sha = await ports.mergeCommit(repo, state.pr!, checkPolling(config));
  if (sha === undefined) {
    return escalateAndFinish(
      job,
      'The pull request did not merge in time, or it closed without a merge.',
      'not merged',
    );
  }
  const checks = await log.step('main-checks', { pr: state.pr, sha }, () =>
    ports.waitForBaseChecks(repo, sha, checkWaiting(config, true)),
  );
  log.event('main-checks.state', { state: checks });
  if (checks === 'pass' || checks === 'none') {
    return GATE_PASSED;
  }
  job.mainBroken = true;
  if (checks !== 'fail') {
    return escalateAndFinish(
      job,
      'The checks on main did not finish in time.',
      'main checks timeout',
    );
  }
  return failedBaseFix(job, sha);
}

async function failedBaseFix(job: Run, sha: string): Promise<Gate> {
  const { context, state, worktree } = job;
  const { repo, config, ports } = context;
  const { round, limit } = budgetUse(job, 'ciFixes');
  if (round >= limit) {
    return escalateAndFinish(
      job,
      `The checks on main failed and the limit of ${limit} check fixes was reached.`,
      'check budget',
    );
  }
  await ports.resetToBase(worktree, context.base, config.remote);
  state.ciFixes += 1;
  state.baseFix = { sha, head: await ports.revision(worktree) };
  await writeState(repo, state);
  return fixBase(job);
}

export async function fixBase(job: Run): Promise<Gate> {
  const { context, issue, log, state } = job;
  const { repo, config, ports } = context;
  const { sha, head } = state.baseFix!;
  const logs = await ports.failedBaseLogs(repo, sha, config.logMaxChars);
  log.event('main-checks.logs', { chars: logs.length });
  const fix = await fixRound(
    job,
    'The checks on main failed after the merge.',
    logs,
    [],
    'checks',
    true,
    head,
  );
  if (!fix.committed) {
    return escalateCheckFix(job, fix.unrelated, 'checks on main');
  }
  await ports.reopenIssue(repo, issue.number);
  state.reviewRounds = 0;
  state.reviewLog = [];
  state.baseFix = undefined;
  await openPr(job);
  return GATE_FIXED;
}
