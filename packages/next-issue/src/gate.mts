import { budgetUse } from './budget.mts';
import { type CheckState, checkWaiting } from './check-poll.mts';
import { escalateCheckFix, fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { type Gate, GATE_FIXED, GATE_PASSED, type Run } from './job.mts';
import { revert } from './revert.mts';
import { writeState } from './state.mts';

export async function checkGate(job: Run, sha: string): Promise<Gate> {
  const { base } = job.context;
  const checks = await rerunOnce(job, sha, await waitForChecks(job, sha));
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
  if (checks !== 'fail') {
    return checks;
  }
  const { context, log } = job;
  const runs = await context.ports.rerunFailedBase(context.repo, sha);
  log.event('main-checks.rerun', { sha, runs });
  return waitForChecks(job, sha, { rerun: true });
}

async function failedChecksFix(job: Run, sha: string): Promise<Gate> {
  const { context, log, state } = job;
  const { repo, config, ports, base } = context;
  const { round, limit } = budgetUse(job, 'ciFixes');
  if (round >= limit) {
    const reverted = await revert(job);
    return escalateAndFinish(
      job,
      `The checks on ${base} failed and the limit of ${limit} check fixes was reached.${reverted}`,
      'check budget',
    );
  }
  state.ciFixes += 1;
  await writeState(repo, state);
  const logs = await ports.failedBaseLogs(repo, sha, config.logMaxChars);
  log.event('main-checks.logs', { chars: logs.length });
  const fix = await fixRound(
    job,
    `The checks on ${base} failed after the change landed there.`,
    logs,
    [],
    'checks',
  );
  if (!fix.committed) {
    const reverted = await revert(job);
    return escalateCheckFix(job, fix.unrelated, `checks on ${base}`, reverted);
  }
  job.repairing = true;
  return GATE_FIXED;
}
