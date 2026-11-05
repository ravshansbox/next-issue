import { parseCommitSubject } from './agent-reply.mts';
import { checkPolling } from './config.mts';
import { commitWork, runFixer } from './fix.mts';
import { spendBudget } from './budget.mts';
import { escalateAndFinish } from './handover.mts';
import { type Gate, GATE_FIXED, type Run } from './job.mts';

export async function conflicts(job: Run): Promise<boolean> {
  const { repo, config, ports } = job.context;
  return ports.prConflicts(repo, job.state.pr!, checkPolling(config));
}

export async function resolveConflict(job: Run): Promise<Gate> {
  const { context, log, worktree, branch } = job;
  const { config, ports } = context;
  const exhausted = await spendBudget(
    job,
    'ciFixes',
    `The pull request conflicts with its base, and the limit of ${config.maxCiFixes} check fixes was reached.`,
    'merge conflict',
  );
  if (exhausted) {
    return exhausted;
  }
  const before = await ports.revision(worktree);
  const files = await log.step('merge-base', { base: context.base }, () =>
    ports.startMerge(worktree, context.base, config.remote),
  );
  log.event('merge-base.conflicts', { files }, 'quiet');
  if (files !== undefined && !(await mergeBase(job, before, files))) {
    await ports.abortMerge(worktree, before);
    return escalateAndFinish(
      job,
      'The fixer left the conflict with the base unresolved.',
      'merge conflict',
    );
  }
  await ports.push(worktree, config.remote, branch);
  return GATE_FIXED;
}

function fixConflict(job: Run, files: string[]): Promise<string> {
  const reason = 'The pull request conflicts with its base.';
  return runFixer(job, reason, files.join('\n'), [], 'conflict');
}

async function mergeBase(job: Run, before: string, files: string[]): Promise<boolean> {
  const { context, worktree } = job;
  const { config, ports } = context;
  try {
    const text = files.length > 0 ? await fixConflict(job, files) : '';
    const subject = parseCommitSubject(text, `chore: merge ${config.remote}/${context.base}`);
    return await commitWork(job, before, subject, 'fixer', (cwd, message) =>
      ports.commitMerge(cwd, files, message),
    );
  } catch (error) {
    await ports.abortMerge(worktree, before);
    throw error;
  }
}
