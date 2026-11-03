import { CODING } from './agents.mts';
import { escalate, finish } from './handover.mts';
import type { Gate, Run } from './job.mts';
import { fixPrompt } from './prompts.mts';
import { writeState } from './state.mts';

export async function conflicts(job: Run): Promise<boolean> {
  const { repo, config, ports } = job.context;
  return ports.prConflicts(repo, job.state.pr!, {
    intervalSeconds: config.checkIntervalSeconds,
    timeoutMs: config.checkTimeoutMinutes * 60_000,
  });
}

export async function resolveConflict(job: Run): Promise<Gate> {
  const { context, issue, log, state, worktree, branch } = job;
  const { repo, config, ports } = context;
  if (state.ciFixes >= config.maxCiFixes) {
    await escalate(
      job,
      `The pull request conflicts with its base, and the limit of ${config.maxCiFixes} check fixes was reached.`,
    );
    return { done: true, report: await finish(job, 'needs-human', 'merge conflict') };
  }
  state.ciFixes += 1;
  await writeState(repo, state);
  const before = await ports.revision(worktree);
  const files = await log.step('merge-base', { base: context.base }, () =>
    ports.startMerge(worktree, context.base, config.remote),
  );
  log.event('merge-base.conflicts', { files }, 'quiet');
  if (files.length > 0) {
    const reason = 'The pull request conflicts with its base.';
    await log.step(
      'fix',
      { reason, cause: 'conflict', round: state.ciFixes, limit: config.maxCiFixes },
      () =>
        ports.runAgent(log, {
          name: 'fixer',
          cwd: worktree,
          prompt: fixPrompt(issue, reason, files.join('\n'), [], 'conflict', job.reply),
          profile: CODING,
          model: config.models.fixer,
          timeoutMs: config.agentTimeoutMinutes * 60_000,
        }),
    );
  }
  if (!(await ports.commitMerge(worktree, files))) {
    await ports.abortMerge(worktree, before);
    await escalate(job, 'The fixer left the conflict with the base unresolved.');
    return { done: true, report: await finish(job, 'needs-human', 'merge conflict') };
  }
  await ports.push(worktree, config.remote, branch);
  return { done: false, fixed: true };
}
