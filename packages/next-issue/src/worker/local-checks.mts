import { refundIfCut, spendBudget } from './budget.mts';
import { evenWhenStopped, refuseWhenStopped } from '../shared/children.mts';
import { minutesToMs } from '../shared/durations.mts';
import { succeeded } from '../shared/exec.mts';
import { escalateCheckFix, fixRound } from './fix.mts';
import type { Finished, Run } from '../shared/job.mts';
import type { CheckResult } from '../shared/ports.mts';
import { writeState } from '../shared/state.mts';
import { SCRIPTS, scriptRunner } from '../shared/setup.mts';
import { outputBlock } from '../shared/text.mts';
import { setUpBeforeChecks } from './worktree-setup.mts';

/**
 * Runs the `format`, `lint`, `typecheck` and `test` scripts in the worktree before a push.
 * Gives `true` when every command passed, `false` when the fixer committed a fix (merge and check again),
 * or the finished hand-over.
 */
export async function localChecks(job: Run): Promise<Finished | boolean> {
  const { context, state, worktree } = job;
  const { ports, repo } = context;
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
  const runner = await scriptRunner(worktree);
  for (const command of SCRIPTS.map((script) => `${runner} ${script}`)) {
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
    log.record('check.output', {
      cmd: command,
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
    });
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
  const { context, log } = job;
  const { config, base } = context;
  const note = failure(job, command, result);
  log.event('check.fail', { cmd: command, code: result.code, timedOut: result.timedOut });
  const exhausted = await spendBudget(
    job,
    'ciFixes',
    `${note} The limit of ${config.maxCiFixes} check fixes was reached, so the harness did not push the change to ${base}.${outputBlock(result.output)}`,
    `local checks failed: ${command}`,
  );
  if (exhausted) {
    return exhausted;
  }
  const fix = await refundIfCut(job, 'ciFixes', () =>
    fixRound(
      job,
      `${note} The harness runs it before the push to ${base}.`,
      result.output,
      [],
      'local',
    ),
  );
  if (!fix.committed) {
    return escalateCheckFix(job, fix.unrelated, `local checks (\`${command}\`)`);
  }
  return false;
}
