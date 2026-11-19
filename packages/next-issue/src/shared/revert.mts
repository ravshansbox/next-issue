import { runStopped } from './children.mts';
import { message } from './errors.mts';
import { commitMessage, fallbackTitle, type Run, titleSubject } from './job.mts';
import { updateLocalBase } from './local-base.mts';
import { type IssueState, writeState } from './state.mts';
import { HALT_NOTE, releaseSettled } from './unsettled.mts';

export async function revertFailedFix(job: Run): Promise<string> {
  if (!job.repairing || job.state.pushing !== undefined || (job.state.landed ?? []).length === 0) {
    return '';
  }
  job.repairing = false;
  return revertFailedChecks(job);
}

/** Hands over a fix of failed checks; once the revert ends with no stop, its saved halt gives way, so the run halt alone holds back other landings. */
export async function revertFailedChecks(job: Run): Promise<string> {
  const reverted = await revertOrReport(job);
  const { context, state } = job;
  if (
    state.halted === true &&
    state.pushing === undefined &&
    state.reverting === undefined &&
    !runStopped()
  ) {
    delete state.halted;
    await writeState(context.repo, state);
  }
  return reverted;
}

export async function revertOrReport(job: Run): Promise<string> {
  try {
    return await revert(job);
  } catch (error) {
    if (runStopped()) {
      throw error;
    }
    job.repairing = false;
    const { context, state } = job;
    if (state.reverting !== undefined) {
      // The revert push was tried and its result is unknown, like a push unknown: the halt is saved.
      state.halted = true;
      await writeState(context.repo, state);
      return ` The revert of the change on ${context.base} failed: ${sentence(message(error))} The revert may be on \`${context.base}\`, and its checks were not awaited. ${HALT_NOTE}`;
    }
    return ` The revert of the change on ${job.context.base} failed: ${sentence(message(error))} The landed commits stay on ${job.context.base}.`;
  }
}

export function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

export function reapplyMessage(job: Run): string {
  const { issue, state } = job;
  return commitMessage(state.changeTitle ?? state.title ?? fallbackTitle(issue), issue);
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
  const reverted = await log.step('revert', { base, shas }, () =>
    ports.revertOnBase(worktree, {
      base,
      remote: config.remote,
      branch,
      shas,
      message: commitMessage(titleSubject('revert', issue), issue),
      reapply: reapplyMessage(job),
      pushing: async (sha) => {
        state.reverting = sha;
        await writeState(repo, state);
      },
    }),
  );
  state.reverting = undefined;
  if (reverted === 'failed') {
    await writeState(repo, state);
    return ` The revert of the change on ${base} failed, so the landed commits stay on ${base}.`;
  }
  restoreChange(state);
  releaseSettled(state);
  await writeState(repo, state);
  if (reverted === 'already reverted') {
    return ` The change is already reverted on ${base}, so the harness pushed no revert.`;
  }
  await updateLocalBase(job);
  return ` The harness reverted the change on ${base}.`;
}
