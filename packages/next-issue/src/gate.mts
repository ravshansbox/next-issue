import { conflicts, resolveConflict } from './conflict.mts';
import { fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { checkPolling, type Gate, history, type Run } from './job.mts';
import { writeState } from './state.mts';

export async function checkGate(job: Run): Promise<Gate> {
  const { context, log, state, worktree } = job;
  const { repo, config, ports } = context;
  const head = await ports.revision(worktree);
  const checks = await log.step('checks', { pr: state.pr, head }, () =>
    ports.waitForChecks(repo, state.pr!, {
      head,
      ...checkPolling(config),
      graceMs: job.noChecks ? 0 : config.checkGraceSeconds * 1000,
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
    return { done: false, fixed: false };
  }
  if (state.ciFixes >= config.maxCiFixes) {
    return escalateAndFinish(
      job,
      `The limit of ${config.maxCiFixes} check fixes was reached.`,
      'check budget',
    );
  }
  state.ciFixes += 1;
  await writeState(repo, state);
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
    const note = fix.unrelated;
    if (note === undefined) {
      return escalateAndFinish(
        job,
        'The fixer added no commit for the failed checks.',
        'no fix commit',
      );
    }
    return escalateAndFinish(
      job,
      `The checks fail for a reason this change did not cause: ${note}`,
      'unrelated failure',
    );
  }
  return { done: false, fixed: true };
}
