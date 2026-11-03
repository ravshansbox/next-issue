import { CODING } from './agents.mts';
import { commitWork } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { checkPolling, type Gate, type Run, runRole } from './job.mts';
import { fixPrompt, parseCommitSubject } from './prompts.mts';
import { writeState } from './state.mts';

export async function conflicts(job: Run): Promise<boolean> {
  const { repo, config, ports } = job.context;
  return ports.prConflicts(repo, job.state.pr!, checkPolling(config));
}

export async function resolveConflict(job: Run): Promise<Gate> {
  const { context, log, state, worktree, branch } = job;
  const { repo, config, ports } = context;
  if (state.ciFixes >= config.maxCiFixes) {
    return escalateAndFinish(
      job,
      `The pull request conflicts with its base, and the limit of ${config.maxCiFixes} check fixes was reached.`,
      'merge conflict',
    );
  }
  state.ciFixes += 1;
  await writeState(repo, state);
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
  return { done: false, fixed: true };
}

async function fixConflict(job: Run, files: string[]): Promise<string> {
  const { context, issue, log, state } = job;
  const reason = 'The pull request conflicts with its base.';
  const result = await log.step(
    'fix',
    { reason, cause: 'conflict', round: state.ciFixes, limit: context.config.maxCiFixes },
    () =>
      runRole(
        job,
        'fixer',
        fixPrompt(issue, reason, files.join('\n'), [], 'conflict', job.reply),
        CODING,
      ),
  );
  return result.text;
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
