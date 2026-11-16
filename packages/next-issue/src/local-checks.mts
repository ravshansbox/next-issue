import { budgetUse, refundBudget, refundOnKill } from './budget.mts';
import { evenWhenStopped, refuseWhenStopped, runStopped } from './children.mts';
import { minutesToMs } from './durations.mts';
import { succeeded } from './exec.mts';
import { escalateCheckFix, type Fix, fixRound } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import type { Finished, Run } from './job.mts';
import type { CheckResult } from './ports.mts';
import { writeState } from './state.mts';
import { outputBlock } from './text.mts';
import { setUpBeforeChecks } from './worktree-setup.mts';

/**
 * Runs the configured check commands in the worktree before a push.
 * Gives `true` when every command passed, `false` when the fixer committed a fix (merge and check again),
 * or the finished hand-over.
 */
export async function localChecks(job: Run): Promise<Finished | boolean> {
  const { context, state, worktree } = job;
  const { config, ports, repo } = context;
  if (config.checks.length === 0) {
    return true;
  }
  const change = await ports.revision(worktree);
  const setup = await setUpBeforeChecks(job);
  if (setup !== undefined) {
    return setup;
  }
  state.squashing = change;
  await writeState(repo, state);
  await ports.saveSetupOutput(worktree);
  let failed: Failed | undefined;
  try {
    failed = await runChecks(job);
  } finally {
    await evenWhenStopped(() => ports.discardChanges(worktree, change));
    state.squashing = undefined;
    await writeState(repo, state);
  }
  return failed === undefined ? true : failedCheck(job, failed.command, failed.result);
}

interface Failed {
  command: string;
  result: CheckResult;
}

async function runChecks(job: Run): Promise<Failed | undefined> {
  const { context, log, worktree } = job;
  const { config, ports } = context;
  const head = await ports.revision(worktree);
  for (const command of config.checks) {
    const result = await log.step('check', { cmd: command }, () =>
      ports.runCheck(
        command,
        worktree,
        minutesToMs(config.checksTimeoutMinutes),
        config.logMaxChars,
      ),
    );
    await evenWhenStopped(() => ports.discardChanges(worktree, head));
    // A stop kills the command, so its failure is no finding: the next run checks again.
    refuseWhenStopped();
    log.event(
      'check.output',
      { cmd: command, code: result.code, timedOut: result.timedOut, output: result.output },
      'verbose',
    );
    if (!succeeded(result) || result.timedOut) {
      return { command, result };
    }
  }
  return undefined;
}

function failure(job: Run, command: string, result: CheckResult): string {
  return result.timedOut
    ? `The local check \`${command}\` did not finish in ${job.context.config.checksTimeoutMinutes} minutes.`
    : `The local check \`${command}\` failed with code ${result.code}.`;
}

async function failedCheck(
  job: Run,
  command: string,
  result: CheckResult,
): Promise<Finished | false> {
  const { context, log, state } = job;
  const { repo, base } = context;
  const note = failure(job, command, result);
  log.event('check.fail', { cmd: command, code: result.code, timedOut: result.timedOut }, 'quiet');
  const { round, limit } = budgetUse(job, 'ciFixes');
  if (round >= limit) {
    return escalateAndFinish(
      job,
      `${note} The limit of ${limit} check fixes was reached, so the harness did not push the change to ${base}.${outputBlock(result.output)}`,
      `local checks failed: ${command}`,
    );
  }
  state.ciFixes += 1;
  await writeState(repo, state);
  let fix: Fix;
  try {
    fix = await refundOnKill(job, 'ciFixes', () =>
      fixRound(
        job,
        `${note} The harness runs it before the push to ${base}.`,
        result.output,
        [],
        'local',
      ),
    );
  } catch (error) {
    if (runStopped()) {
      await refundBudget(job, 'ciFixes');
    }
    throw error;
  }
  if (!fix.committed) {
    return escalateCheckFix(job, fix.unrelated, `local checks (\`${command}\`)`);
  }
  return false;
}
