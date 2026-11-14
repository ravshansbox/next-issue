import { runStopped } from './children.mts';
import { message } from './errors.mts';
import type { Run } from './job.mts';
import { type IssueState, writeState } from './state.mts';

export async function revertFailedFix(job: Run): Promise<string> {
  if (!job.repairing || (job.state.landed ?? []).length === 0) {
    return '';
  }
  job.repairing = false;
  return revertOrReport(job);
}

export async function revertOrReport(job: Run): Promise<string> {
  try {
    return await revert(job);
  } catch (error) {
    if (runStopped()) {
      throw error;
    }
    job.repairing = false;
    return ` The revert of the change on ${job.context.base} failed: ${sentence(message(error))} The landed commits stay on ${job.context.base}.`;
  }
}

export function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export function reapplyMessage(job: Run): string {
  const { number } = job.issue;
  return `${job.state.changeTitle ?? job.state.title ?? `fix: resolve issue #${number}`}\n\nRefs #${number}`;
}

export function restoreChange(state: IssueState): void {
  state.landed = undefined;
  state.title = state.changeTitle ?? state.title;
  state.changeTitle = undefined;
  if (state.phase === 'approved') {
    state.phase = 'review';
  }
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
      reapply: reapplyMessage(job),
      pushing: async (sha) => {
        state.reverting = sha;
        await writeState(repo, state);
      },
    }),
  );
  state.reverting = undefined;
  if (!pushed) {
    await writeState(repo, state);
    return ` The revert of the change on ${base} failed, so the landed commits stay on ${base}.`;
  }
  restoreChange(state);
  await writeState(repo, state);
  return ` The harness reverted the change on ${base}.`;
}
