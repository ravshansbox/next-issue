import { budgetUse } from './budget.mts';
import { type CheckState, checkWaiting } from './check-poll.mts';
import { runStopped } from './children.mts';
import { asError, message } from './errors.mts';
import { escalateCheckFix, type Fix, fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { type Finished, type Gate, GATE_FIXED, GATE_PASSED, type Run } from './job.mts';
import { revertOrReport, sentence } from './revert.mts';
import { writeState } from './state.mts';

export async function checkGate(job: Run, sha: string): Promise<Gate> {
  const { base } = job.context;
  let checks: CheckState;
  try {
    checks = await rerunOnce(job, sha, await waitForChecks(job, sha));
  } catch (error) {
    if (!job.mainBroken) {
      throw error;
    }
    return escalateError(job, error, `The read of the checks on ${base} failed`, 'checks error');
  }
  if (checks === 'pass' || checks === 'none') {
    return GATE_PASSED;
  }
  job.mainBroken = true;
  if (checks !== 'fail') {
    return escalateAndFinish(
      job,
      `The checks on ${base} did not finish in time.`,
      'main checks timeout',
    );
  }
  return failedChecksFix(job, sha);
}

async function waitForChecks(job: Run, sha: string, fields = {}): Promise<CheckState> {
  const { context, log } = job;
  const { repo, config, ports } = context;
  const checks = await log.step('main-checks', { sha, ...fields }, () =>
    ports.waitForBaseChecks(repo, sha, checkWaiting(config, true)),
  );
  log.event('main-checks.state', { state: checks, ...fields });
  return checks;
}

async function rerunOnce(job: Run, sha: string, checks: CheckState): Promise<CheckState> {
  const { context, log, state } = job;
  if (checks !== 'fail' || state.rerun === sha) {
    return checks;
  }
  state.rerun = sha;
  await writeState(context.repo, state);
  try {
    const runs = await context.ports.rerunFailedBase(context.repo, sha);
    log.event('main-checks.rerun', { sha, runs });
  } catch (error) {
    log.event('main-checks.rerun-failed', { sha, error: asError(error).message });
    return checks;
  }
  return waitForChecks(job, sha, { rerun: true }).catch((error: unknown) => {
    job.mainBroken = true;
    throw error;
  });
}

async function failedChecksFix(job: Run, sha: string): Promise<Gate> {
  const { context, log, state } = job;
  const { repo, config, ports, base } = context;
  const { round, limit } = budgetUse(job, 'ciFixes');
  if (round >= limit) {
    const reverted = await revertOrReport(job);
    return escalateAndFinish(
      job,
      `The checks on ${base} failed and the limit of ${limit} check fixes was reached.${reverted}`,
      'check budget',
    );
  }
  state.ciFixes += 1;
  await writeState(repo, state);
  let logs: string;
  try {
    logs = await ports.failedBaseLogs(repo, sha, config.logMaxChars);
  } catch (error) {
    return escalateError(
      job,
      error,
      `The read of the failed checks on ${base} failed`,
      'logs error',
    );
  }
  log.event('main-checks.logs', { chars: logs.length });
  let fix: Fix;
  try {
    fix = await fixRound(
      job,
      `The checks on ${base} failed after the change landed there.`,
      logs,
      [],
      'checks',
    );
  } catch (error) {
    return escalateError(
      job,
      error,
      `The fixer for the failed checks on ${base} failed`,
      'fixer error',
    );
  }
  if (!fix.committed) {
    const reverted = await revertOrReport(job);
    return escalateCheckFix(job, fix.unrelated, `checks on ${base}`, reverted);
  }
  job.repairing = true;
  return GATE_FIXED;
}

export async function escalateError(
  job: Run,
  error: unknown,
  note: string,
  reason: string,
): Promise<Finished> {
  if (runStopped()) {
    throw error;
  }
  const reverted = await revertOrReport(job);
  return escalateAndFinish(job, `${note}: ${sentence(message(error))}${reverted}`, reason);
}
