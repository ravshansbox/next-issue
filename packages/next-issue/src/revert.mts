import type { Run } from './job.mts';
import { writeState } from './state.mts';

export async function revertFailedFix(job: Run): Promise<string> {
  if (!job.repairing || (job.state.landed ?? []).length === 0) {
    return '';
  }
  job.repairing = false;
  return revert(job);
}

export async function revert(job: Run): Promise<string> {
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
    return ` The revert of the change on ${base} failed, so the landed commits stay on ${base}.`;
  }
  state.landed = undefined;
  await writeState(repo, state);
  return ` The harness reverted the change on ${base}.`;
}
