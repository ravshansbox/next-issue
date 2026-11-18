import { parseCommitSubject } from './agent-reply.mts';
import { refundBudget, refundOnKill, spendBudget } from './budget.mts';
import { runStopped } from '../shared/children.mts';
import type { Merge } from '../shared/git-merge.mts';
import { commitWork, runFixer } from './fix.mts';
import { escalateAndFinish } from '../shared/handover.mts';
import { fallbackTitle, type Finished, type Run } from '../shared/job.mts';
import { writeState } from '../shared/state.mts';

export async function rebase(job: Run): Promise<Finished | undefined> {
  const { context, issue, log, state, worktree } = job;
  const { config, ports, base } = context;
  const title = state.title ?? fallbackTitle(issue);
  const before = await ports.revision(worktree);
  const { target, files, unmarked } = await log.step('rebase', { base }, () =>
    ports.startMerge(worktree, base, config.remote),
  );
  if (files !== undefined) {
    log.event('rebase.conflicts', { files });
    if (unmarked.length > 0) {
      await ports.abortMerge(worktree, before);
      return escalateAndFinish(
        job,
        `The change conflicts with ${base} in files that hold no conflict marker, such as a deleted, renamed or binary file: ${unmarked.join(', ')}.`,
        'merge conflict',
      );
    }
    const merged = await mergeBase(job, { before, target, files });
    if (merged !== undefined) {
      return merged;
    }
    state.title = title;
  }
  const merged = await ports.revision(worktree);
  const squashed = await commitWork(job, merged, title, 'fixer', (cwd, message) =>
    squash(job, cwd, target, message),
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

async function squash(job: Run, cwd: string, target: string, message: string): Promise<boolean> {
  const { context, state } = job;
  state.squashing = await context.ports.revision(cwd);
  await writeState(context.repo, state);
  try {
    return await context.ports.squashOnto(cwd, target, message);
  } finally {
    state.squashing = undefined;
  }
}

async function mergeBase(job: Run, merge: Merge): Promise<Finished | undefined> {
  const { before, files } = merge;
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
  if (!(await resolve(job, merge))) {
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

async function resolve(job: Run, merge: Merge): Promise<boolean> {
  const { context, worktree } = job;
  const { before, files } = merge;
  const { config, ports } = context;
  try {
    const fixAndCommit = async (): Promise<boolean> => {
      const text = files.length > 0 ? await fixConflict(job, files) : '';
      const subject = parseCommitSubject(text, `chore: merge ${config.remote}/${context.base}`);
      return commitWork(job, before, subject, 'fixer', (cwd, message) =>
        ports.commitMerge(cwd, merge, message),
      );
    };
    return await (files.length > 0 ? refundOnKill(job, 'ciFixes', fixAndCommit) : fixAndCommit());
  } catch (error) {
    if (files.length > 0 && runStopped()) {
      await refundBudget(job, 'ciFixes');
    }
    await ports.abortMerge(worktree, before);
    throw error;
  }
}
