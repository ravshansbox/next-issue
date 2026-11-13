import { ROUND_CONTINUE, type Round, type Run } from './job.mts';
import { resumeLanding } from './land.mts';
import { writeState } from './state.mts';

export async function enterReview(job: Run): Promise<Round> {
  const { context, state } = job;
  const landed = state.landed?.at(-1);
  if (landed !== undefined) {
    return resumeLanding(job, landed);
  }
  state.phase = 'review';
  await writeState(context.repo, state);
  return ROUND_CONTINUE;
}
