import type { Restarted } from '../shared/ci-checks.mts';
import { refundIfCut, spendBudget } from './budget.mts';
import { type CheckState, checkWaiting } from '../shared/check-poll.mts';
import { runStopped } from '../shared/children.mts';
import { asError, message } from '../shared/errors.mts';
import { untrusted } from '../shared/prompts.mts';
import { escalateCheckFix, type Fix, fixRound } from './fix.mts';
import { escalateAndFinish } from '../shared/handover.mts';
import { type Finished, type Gate, GATE_FIXED, GATE_PASSED, type Run } from '../shared/job.mts';
import { revertFailedChecks, revertOrReport, sentence } from '../shared/revert.mts';
import { writeState } from '../shared/state.mts';
import { HALT_NOTE } from '../shared/unsettled.mts';

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
  if (checks === 'pass' || checks === 'none') {
    if (job.state.halted === true) {
      delete job.state.halted;
      await writeState(job.context.repo, job.state);
    }
    return GATE_PASSED;
  }
  job.mainBroken = true;
  if (checks !== 'fail') {
    job.state.halted = true;
  }
  if (checks === 'cancelled') {
    return escalateAndFinish(
      job,
      `The checks on ${base} were cancelled before they finished. ${HALT_NOTE}`,
      'main checks cancelled',
    );
  }
  if (checks === 'cut') {
    return escalateAndFinish(
      job,
      `A job in \`ignoredChecks\` failed on ${base} and GitHub cancelled or skipped another job of its workflow run before it finished, for example through \`strategy.fail-fast\` or a \`needs\` on the ignored job. Rerun the cancelled or skipped job, or set \`fail-fast: false\` and drop the \`needs\` so an ignored job no longer stops the others. ${HALT_NOTE}`,
      'main checks cut short',
    );
  }
  if (checks === 'limited') {
    return escalateAndFinish(
      job,
      `GitHub refused to read the checks on ${base} with a rate limit until \`checkTimeoutMinutes\` ran out, so nobody knows whether they passed. Another user of the same token may have used up its rate limit. ${HALT_NOTE}`,
      'main checks timeout',
    );
  }
  if (checks !== 'fail') {
    return escalateAndFinish(
      job,
      `The checks on ${base} did not finish in time. ${HALT_NOTE}`,
      'main checks timeout',
    );
  }
  job.state.halted = true;
  await writeState(job.context.repo, job.state);
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
  const checks = await log.step('ci-checks', { sha, ...fields }, () =>
    ports.waitForCiChecks(
      repo,
      sha,
      context.base,
      checkWaiting(config, true),
      restarted,
      config.ignoredChecks,
    ),
  );
  log.event('ci-checks.state', { state: checks, ...fields });
  return checks;
}

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
    const runs = await context.ports.rerunFailedCi(
      context.repo,
      sha,
      context.base,
      (run) => {
        restarted.push(run);
      },
      context.config.ignoredChecks,
    );
    log.event('ci-checks.rerun', { sha, runs });
  } catch (error) {
    if (runStopped()) {
      throw error;
    }
    if (restarted.length === 0) {
      log.event('ci-checks.rerun-failed', { sha, error: asError(error).message });
      return restarted;
    }
    log.event('ci-checks.rerun', {
      sha,
      runs: restarted.map((run) => String(run.id)),
      error: asError(error).message,
    });
  }
  return restarted;
}

async function failedChecksFix(job: Run, sha: string, refused?: string): Promise<Gate> {
  const { context, log, state } = job;
  const { repo, config, ports, base } = context;
  const exhausted = await spendBudget(
    job,
    'ciFixes',
    `The checks on ${base} failed and the limit of ${config.maxCiFixes} check fixes was reached.`,
    'check budget',
    () => revertFailedChecks(job),
  );
  if (exhausted) {
    return exhausted;
  }
  let logs: string;
  try {
    logs = await refundIfCut(job, 'ciFixes', () =>
      ports.failedCiLogs(repo, sha, base, config.logMaxChars, config.ignoredChecks),
    );
  } catch (error) {
    return escalateError(
      job,
      error,
      `The read of the failed checks on ${base} failed`,
      'logs error',
    );
  }
  log.event('ci-checks.logs', { chars: logs.length });
  let fix: Fix;
  try {
    fix = await refundIfCut(job, 'ciFixes', () =>
      fixRound(
        job,
        `The checks on ${base} failed after the change landed there.${refusedNote(refused)}`,
        logs,
        [],
        'checks',
      ),
    );
  } catch (error) {
    return escalateError(
      job,
      error,
      `The fixer for the failed checks on ${base} failed`,
      'fixer error',
    );
  }
  if (!fix.committed && fix.unrelated !== undefined) {
    let files: string[];
    try {
      files = await ports.changedFiles(job.worktree, state.landed ?? []);
    } catch (error) {
      return escalateError(job, error, 'The read of the files of the change failed', 'files error');
    }
    const named = namedFile(logs, files, repo.name);
    if (named !== undefined) {
      log.event('fix.refused', { file: named });
      return failedChecksFix(job, sha, named);
    }
  }
  if (!fix.committed) {
    const reverted = await revertFailedChecks(job);
    return escalateCheckFix(job, fix.unrelated, `checks on ${base}`, reverted);
  }
  job.repairing = true;
  return GATE_FIXED;
}

function refusedNote(refused: string | undefined): string {
  return refused === undefined
    ? ''
    : ` The last fixer called the failure unrelated, but the failed logs name a file of this change, so the failure is not unrelated:\n${untrusted(refused)}`;
}

function namedFile(logs: string, files: string[], repo: string): string | undefined {
  const name = `(?i:${escapeRegExp(repo)})`;
  const prefixes = `|(?<=(?<![\\w./-])\\./)|(?<=/${name}/${name}/)`;
  return files.find((file) => {
    const parts = file.split('/');
    const tails =
      parts.length === 1
        ? [file]
        : parts.slice(0, -1).map((_, index) => parts.slice(index).join('/'));
    return tails.some((tail) =>
      new RegExp(
        `(?:(?<![\\w./-])${tail === file ? prefixes : ''})${escapeRegExp(tail)}(?![\\w.-])`,
      ).test(logs),
    );
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  const reverted = await revertFailedChecks(job);
  return escalateAndFinish(job, `${note}: ${sentence(message(error))}${reverted}`, reason);
}
