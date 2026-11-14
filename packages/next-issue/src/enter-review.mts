import { escalateAndFinish } from './handover.mts';
import { ROUND_CONTINUE, type Round, type Run } from './job.mts';
import { landApproved, resumeLanding } from './land.mts';
import { reapplyMessage, restoreChange } from './revert.mts';
import { writeState } from './state.mts';
import { beforeBaseSettled } from './unsettled.mts';

export async function enterReview(job: Run): Promise<Round> {
  const { context, state } = job;
  const reverted = await beforeBaseSettled(state, context.base, async () => {
    await settlePush(job);
    return settleRevert(job);
  });
  if (reverted) {
    job.mainBroken = true;
    const { base } = context;
    return escalateAndFinish(
      job,
      `The run stopped during the revert of the change on ${base}. The harness reverted the change on ${base}.`,
      'revert stopped',
    );
  }
  const landed = state.landed?.at(-1);
  await beforeBaseSettled(state, context.base, async () => {
    await settleSquash(job);
    if (landed !== undefined || state.phase === 'approved') {
      const { ports } = context;
      await ports.discardChanges(job.worktree, await ports.revision(job.worktree), job.branch);
    }
  });
  if (landed !== undefined) {
    return resumeLanding(job, landed);
  }
  if (state.phase === 'approved') {
    return landApproved(job);
  }
  state.phase = 'review';
  await writeState(context.repo, state);
  return ROUND_CONTINUE;
}

async function settlePush(job: Run): Promise<void> {
  const { context, state, worktree } = job;
  const { repo, config, ports, base } = context;
  const sha = state.pushing;
  if (sha === undefined) {
    return;
  }
  if (await ports.isOnBase(worktree, base, config.remote, sha)) {
    state.landed = [...(state.landed ?? []), sha];
  }
  state.pushing = undefined;
  await writeState(repo, state);
}

async function settleSquash(job: Run): Promise<void> {
  const { context, state, worktree, branch } = job;
  const sha = state.squashing;
  if (sha === undefined) {
    return;
  }
  await context.ports.discardChanges(worktree, sha, branch);
  state.squashing = undefined;
  await writeState(context.repo, state);
}

async function settleRevert(job: Run): Promise<boolean> {
  const { context, state, worktree, branch } = job;
  const { repo, config, ports, base } = context;
  const sha = state.reverting;
  if (sha === undefined) {
    return false;
  }
  const reverted = await ports.isOnBase(worktree, base, config.remote, sha);
  if (reverted) {
    await ports.reapplyRevert(worktree, {
      base,
      remote: config.remote,
      branch,
      reverted: sha,
      reapply: reapplyMessage(job),
    });
    restoreChange(state);
  }
  state.reverting = undefined;
  await writeState(repo, state);
  return reverted;
}
