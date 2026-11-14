import { escalateAndFinish } from './handover.mts';
import { ROUND_CONTINUE, type Round, type Run } from './job.mts';
import { resumeLanding } from './land.mts';
import { reapplyMessage } from './revert.mts';
import { writeState } from './state.mts';

export async function enterReview(job: Run): Promise<Round> {
  const { context, state } = job;
  await settlePush(job);
  if (await settleRevert(job)) {
    job.mainBroken = true;
    const { base } = context;
    return escalateAndFinish(
      job,
      `The run stopped during the revert of the change on ${base}. The harness reverted the change on ${base}.`,
      'revert stopped',
    );
  }
  const landed = state.landed?.at(-1);
  if (landed !== undefined) {
    return resumeLanding(job, landed);
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
    state.landed = undefined;
  }
  state.reverting = undefined;
  await writeState(repo, state);
  return reverted;
}
