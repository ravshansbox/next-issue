import { budgetUse } from './budget.mts';
import { checkWaiting } from './check-poll.mts';
import { escalateCheckFix, fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { type Gate, GATE_FIXED, GATE_PASSED, type Run } from './job.mts';
import { writeState } from './state.mts';

export async function checkGate(job: Run, sha: string): Promise<Gate> {
  const { context, log } = job;
  const { repo, config, ports, base } = context;
  const checks = await log.step('main-checks', { sha }, () =>
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
      `The checks on ${base} did not finish in time.`,
      'main checks timeout',
    );
  }
  return failedChecksFix(job, sha);
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
  return GATE_FIXED;
}

async function revert(job: Run): Promise<string> {
  const { context, issue, log, state, branch, worktree } = job;
  const { repo, config, ports, base } = context;
  const shas = state.landed ?? [];
  const pushed = await log.step('revert', { base, shas }, () =>
    ports.revertOnBase(worktree, {
      base,
      remote: config.remote,
      branch,
      shas,
      message: `revert: issue #${issue.number}\n\nRefs #${issue.number}`,
      reapply: `${state.title ?? `fix: resolve issue #${issue.number}`}\n\nRefs #${issue.number}`,
    }),
  );
  if (!pushed) {
    return ` The revert of the change on ${base} failed.`;
  }
  state.landed = undefined;
  await writeState(repo, state);
  return ` The harness reverted the change on ${base}.`;
}
