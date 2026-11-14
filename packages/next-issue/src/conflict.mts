import { parseCommitSubject } from './agent-reply.mts';
import { spendBudget } from './budget.mts';
import { commitWork, runFixer } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { fallbackTitle, type Finished, type Run } from './job.mts';

export async function rebase(job: Run): Promise<Finished | undefined> {
  const { context, issue, log, state, worktree } = job;
  const { config, ports, base } = context;
  const title = state.title ?? fallbackTitle(issue);
  const before = await ports.revision(worktree);
  const files = await log.step('rebase', { base }, () =>
    ports.startMerge(worktree, base, config.remote),
  );
  if (files !== undefined) {
    log.event('rebase.conflicts', { files }, 'quiet');
    const merged = await mergeBase(job, before, files);
    if (merged !== undefined) {
      return merged;
    }
  }
  const merged = await ports.revision(worktree);
  const squashed = await commitWork(job, merged, title, 'fixer', (cwd, message) =>
    ports.squashOnto(cwd, base, config.remote, message),
  );
  if (!squashed) {
    return escalateAndFinish(
      job,
      `The change holds nothing that ${config.remote}/${base} does not already hold.`,
      'empty change',
    );
  }
  return undefined;
}

async function mergeBase(job: Run, before: string, files: string[]): Promise<Finished | undefined> {
  const { context, worktree } = job;
  const { config, ports, base } = context;
  if (files.length > 0) {
    const exhausted = await spendBudget(
      job,
      'ciFixes',
      `The change conflicts with ${base}, and the limit of ${config.maxCiFixes} check fixes was reached.`,
      'merge conflict',
      () => ports.abortMerge(worktree, before),
    );
    if (exhausted) {
      return exhausted;
    }
  }
  if (!(await resolve(job, before, files))) {
    await ports.abortMerge(worktree, before);
    return escalateAndFinish(
      job,
      `The fixer left the conflict with ${base} unresolved.`,
      'merge conflict',
    );
  }
  return undefined;
}

function fixConflict(job: Run, files: string[]): Promise<string> {
  const reason = `The change conflicts with ${job.context.base}.`;
  return runFixer(job, reason, files.join('\n'), [], 'conflict');
}

async function resolve(job: Run, before: string, files: string[]): Promise<boolean> {
  const { context, worktree } = job;
  const { config, ports } = context;
  try {
    const text = files.length > 0 ? await fixConflict(job, files) : '';
    const subject = parseCommitSubject(text, `chore: merge ${config.remote}/${context.base}`);
    return await commitWork(job, before, subject, 'fixer', (cwd, message) =>
      ports.commitMerge(cwd, { before, base: context.base, remote: config.remote, files }, message),
    );
  } catch (error) {
    await ports.abortMerge(worktree, before);
    throw error;
  }
}
