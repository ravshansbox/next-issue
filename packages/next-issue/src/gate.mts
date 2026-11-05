import { checkWaiting } from './config.mts';
import { conflicts, resolveConflict } from './conflict.mts';
import { fixRound } from './fix.mts';
import { spendBudget } from './budget.mts';
import { escalateAndFinish, escalateCheckFix } from './handover.mts';
import { type Gate, GATE_FIXED, GATE_PASSED, type Run } from './job.mts';
import { history } from './prompts.mts';

export async function checkGate(job: Run): Promise<Gate> {
  const { context, log, state, worktree } = job;
  const { repo, config, ports } = context;
  const head = await ports.revision(worktree);
  const checks = await log.step('checks', { pr: state.pr, head }, () =>
    ports.waitForChecks(repo, state.pr!, {
      head,
      ...checkWaiting(config, !job.noChecks),
      show: log.level === 'verbose',
    }),
  );
  log.event('checks.state', { state: checks });
  job.noChecks ||= checks === 'none';
  if (checks === 'timeout') {
    return escalateAndFinish(job, 'The checks did not finish in time.', 'checks timeout');
  }
  if (checks === 'none' && (await conflicts(job))) {
    return resolveConflict(job);
  }
  if (checks === 'moved') {
    return escalateAndFinish(
      job,
      'Someone pushed to the pull request while the harness waited for the checks.',
      'pull request moved',
    );
  }
  if (checks !== 'fail') {
    return GATE_PASSED;
  }
  return failedChecksFix(job);
}

async function failedChecksFix(job: Run): Promise<Gate> {
  const { context, log, state } = job;
  const { repo, config, ports } = context;
  const exhausted = await spendBudget(
    job,
    'ciFixes',
    `The limit of ${config.maxCiFixes} check fixes was reached.`,
    'check budget',
  );
  if (exhausted) {
    return exhausted;
  }
  const logs = await ports.failedCheckLogs(repo, state.pr!, config.logMaxChars);
  log.event('checks.logs', { chars: logs.length });
  const fix = await fixRound(
    job,
    'The continuous integration checks failed.',
    logs,
    history(state.reviewLog),
    'checks',
  );
  if (!fix.committed) {
    return escalateCheckFix(job, fix.unrelated, 'checks');
  }
  return GATE_FIXED;
}
