import type { Restarted } from './base-checks.mts';
import { budgetUse, refundBudget, refundOnKill } from './budget.mts';
import { type CheckState, checkWaiting } from './check-poll.mts';
import { runStopped } from './children.mts';
import { asError, message } from './errors.mts';
import { escalateCheckFix, type Fix, fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { type Finished, type Gate, GATE_FIXED, GATE_PASSED, type Run } from './job.mts';
import { revertOrReport, sentence } from './revert.mts';
import { writeState } from './state.mts';
import { HALT_NOTE } from './unsettled.mts';

export async function checkGate(job: Run, sha: string): Promise<Gate> {
  const { base } = job.context;
  let checks: CheckState;
  try {
    checks = await rerunOnce(job, sha, await waitForChecks(job, sha));
  } catch (error) {
    if (job.mainBroken) {
      return unreadFixChecks(job, error);
    }
    return unreadChecks(job, error);
  }
  // The checks are known now, so an earlier halt on this issue no longer holds back other landings.
  delete job.state.halted;
  if (checks === 'pass' || checks === 'none') {
    return GATE_PASSED;
  }
  job.mainBroken = true;
  if (checks !== 'fail') {
    // Checks that never finished leave the base unknown, so later runs land nothing until a person resumes this issue.
    job.state.halted = true;
  }
  if (checks === 'cancelled') {
    return escalateAndFinish(
      job,
      `The checks on ${base} were cancelled before they finished. ${HALT_NOTE}`,
      'main checks cancelled',
    );
  }
  if (checks !== 'fail') {
    return escalateAndFinish(
      job,
      `The checks on ${base} did not finish in time. ${HALT_NOTE}`,
      'main checks timeout',
    );
  }
  return failedChecksFix(job, sha);
}

async function waitForChecks(
  job: Run,
  sha: string,
  fields = {},
  restarted: Restarted[] = [],
): Promise<CheckState> {
  const { context, log } = job;
  const { repo, config, ports } = context;
  const checks = await log.step('main-checks', { sha, ...fields }, () =>
    ports.waitForBaseChecks(repo, sha, context.base, checkWaiting(config, true), restarted),
  );
  log.event('main-checks.state', { state: checks, ...fields });
  return checks;
}

/** Reruns the failed jobs of each failed workflow run once; GitHub keeps the attempts, so a resume reruns only runs not rerun yet. */
async function rerunOnce(job: Run, sha: string, checks: CheckState): Promise<CheckState> {
  let state = checks;
  while (state === 'fail') {
    const restarted = await rerunFailed(job, sha);
    if (restarted.length === 0) {
      return state;
    }
    state = await waitForChecks(job, sha, { rerun: true }, restarted).catch((error: unknown) => {
      job.mainBroken = true;
      throw error;
    });
  }
  return state;
}

async function rerunFailed(job: Run, sha: string): Promise<Restarted[]> {
  const { context, log } = job;
  const restarted: Restarted[] = [];
  try {
    const runs = await context.ports.rerunFailedBase(context.repo, sha, context.base, (run) => {
      restarted.push(run);
    });
    // An empty list tells why the fixer starts with no rerun: no failed workflow run is left to rerun.
    log.event('main-checks.rerun', { sha, runs });
  } catch (error) {
    if (runStopped()) {
      throw error;
    }
    if (restarted.length === 0) {
      log.event('main-checks.rerun-failed', { sha, error: asError(error).message });
      return restarted;
    }
    // Some runs restarted, so the fixer waits for them rather than getting a failure with no log.
    log.event('main-checks.rerun', {
      sha,
      runs: restarted.map((run) => String(run.id)),
      error: asError(error).message,
    });
  }
  return restarted;
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
    logs = await refundOnKill(job, 'ciFixes', () =>
      ports.failedBaseLogs(repo, sha, base, config.logMaxChars),
    );
  } catch (error) {
    await refundStopped(job);
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
    fix = await refundOnKill(job, 'ciFixes', () =>
      fixRound(
        job,
        `The checks on ${base} failed after the change landed there.`,
        logs,
        [],
        'checks',
      ),
    );
  } catch (error) {
    await refundStopped(job);
    return escalateError(
      job,
      error,
      `The fixer for the failed checks on ${base} failed`,
      'fixer error',
    );
  }
  if (!fix.committed) {
    const reverted = await revertOrReport(job);
    return escalateCheckFix(job, fix.unrelated, `checks on ${base}`, reverted, fix.aside);
  }
  job.repairing = true;
  return GATE_FIXED;
}

async function refundStopped(job: Run): Promise<void> {
  if (runStopped()) {
    await refundBudget(job, 'ciFixes');
  }
}

/** A landed commit whose checks cannot be read leaves the base unknown, so the run halts and keeps the commit. */
async function unreadChecks(job: Run, error: unknown): Promise<Finished> {
  if (runStopped()) {
    throw error;
  }
  const { base } = job.context;
  job.mainBroken = true;
  job.state.halted = true;
  return escalateAndFinish(
    job,
    `The read of the checks on ${base} failed: ${sentence(message(error))} The landed commit is on \`${base}\`, and its checks were not awaited. ${HALT_NOTE}`,
    'checks error',
  );
}

/** A broken base whose checks cannot be read is reverted; while the revert fails, the halt stays saved. */
async function unreadFixChecks(job: Run, error: unknown): Promise<Finished> {
  if (runStopped()) {
    throw error;
  }
  const { context, state } = job;
  state.halted = true;
  await writeState(context.repo, state);
  const reverted = await revertOrReport(job);
  const halt = state.halted === true && !reverted.includes(HALT_NOTE) ? ` ${HALT_NOTE}` : '';
  return escalateAndFinish(
    job,
    `The read of the checks on ${context.base} failed: ${sentence(message(error))}${reverted}${halt}`,
    'checks error',
  );
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
