import { ROUND_CONTINUE, type Round, type Run } from './job.mts';
import { resumeLanding } from './land.mts';
import { writeState } from './state.mts';

export async function enterReview(job: Run): Promise<Round> {
  const { context, state } = job;
  await settlePush(job);
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
