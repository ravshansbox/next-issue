import { finishDone } from './handover.mts';
import { openPr, ROUND_CONTINUE, type Round, type Run } from './job.mts';
import { afterMerge, fixBase } from './merge.mts';

export async function enterReview(job: Run): Promise<Round> {
  const { context, log, state, branch, worktree } = job;
  const { repo, config, ports } = context;
  if (state.baseFix !== undefined) {
    job.mainBroken = true;
    return fixBase(job);
  }
  if (
    state.phase === 'review' &&
    state.pr !== undefined &&
    (await ports.prMerged(repo, state.pr))
  ) {
    return alreadyMerged(job, state.pr);
  }
  await log.step('push', { branch }, () => ports.push(worktree, config.remote, branch));
  state.phase = 'review';
  await openPr(job);
  return ROUND_CONTINUE;
}

async function alreadyMerged(job: Run, pr: number): Promise<Round> {
  job.log.event('pull-request.merged', { pr }, 'quiet');
  if (!job.context.merge) {
    return finishDone(job);
  }
  return afterMerge(job);
}
