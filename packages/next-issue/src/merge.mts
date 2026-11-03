import { secondsToMs } from './config.mts';
import { fixRound } from './fix.mts';
import { escalateAndFinish, finish } from './handover.mts';
import { checkPolling, type Gate, openPr, type Round, type Run, setStatus } from './job.mts';
import { writeState } from './state.mts';

export async function afterMerge(job: Run): Promise<Round> {
  const { context, issue, state } = job;
  const watched = await watchBase(job);
  if (watched.done) {
    return { done: true, report: watched.report };
  }
  if (watched.fixed) {
    return { done: false };
  }
  await setStatus(context, issue.number, state.pr, context.config.labels.done);
  return { done: true, report: await finish(job, 'done') };
}

async function watchBase(job: Run): Promise<Gate> {
  const { context, log, state, worktree } = job;
  const { repo, config, ports } = context;
  const polling = checkPolling(config);
  const sha = await ports.mergeCommit(repo, state.pr!, polling);
  if (sha === undefined) {
    return escalateAndFinish(
      job,
      'The pull request did not merge in time, or it closed without a merge.',
      'not merged',
    );
  }
  const checks = await log.step('main-checks', { pr: state.pr, sha }, () =>
    ports.waitForBaseChecks(repo, sha, {
      ...polling,
      graceMs: secondsToMs(config.checkGraceSeconds),
    }),
  );
  log.event('main-checks.state', { state: checks });
  if (checks === 'pass' || checks === 'none') {
    return { done: false, fixed: false };
  }
  job.mainBroken = true;
  if (checks !== 'fail') {
    return escalateAndFinish(
      job,
      'The checks on main did not finish in time.',
      'main checks timeout',
    );
  }
  if (state.ciFixes >= config.maxCiFixes) {
    return escalateAndFinish(
      job,
      `The checks on main failed and the limit of ${config.maxCiFixes} check fixes was reached.`,
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
    const note = fix.unrelated;
    if (note === undefined) {
      return escalateAndFinish(
        job,
        'The fixer added no commit for the failed checks on main.',
        'no fix commit',
      );
    }
    return escalateAndFinish(
      job,
      `The checks on main fail for a reason this change did not cause: ${note}`,
      'unrelated failure',
    );
  }
  await ports.reopenIssue(repo, issue.number);
  state.reviewRounds = 0;
  state.reviewLog = [];
  state.baseFix = undefined;
  await openPr(job);
  return { done: false, fixed: true };
}
