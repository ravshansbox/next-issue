import { rebase } from './conflict.mts';
import { checkGate } from './gate.mts';
import { escalateAndFinish, finishDone } from './handover.mts';
import type { Finished, Run } from './job.mts';
import { oneAtATime } from './lock.mts';
import { revertFailedFix } from './revert.mts';
import { writeState } from './state.mts';

const PUSH_TRIES = 3;

export function landApproved(job: Run): Promise<Finished> {
  return landing(job, () => landLoop(job));
}

export function resumeLanding(job: Run, sha: string): Promise<Finished> {
  return landing(job, async () => {
    if (await holdsUnlandedFix(job, sha)) {
      job.mainBroken = true;
      job.repairing = true;
      return landLoop(job);
    }
    const gate = await checkGate(job, sha);
    if (gate.done) {
      return gate;
    }
    return gate.fixed ? landLoop(job) : finishDone(job);
  });
}

async function holdsUnlandedFix(job: Run, sha: string): Promise<boolean> {
  const { context, worktree } = job;
  const { ports, config, base } = context;
  if ((await ports.revision(worktree)) === sha) {
    return false;
  }
  return !(await ports.isLanded(worktree, base, config.remote));
}

function landing(job: Run, work: () => Promise<Finished>): Promise<Finished> {
  return oneAtATime(`${job.context.repo.root}#land`, work);
}

async function landLoop(job: Run): Promise<Finished> {
  for (;;) {
    const pushed = await pushChange(job).catch(async (error: unknown) => {
      await revertFailedFix(job);
      throw error;
    });
    if (typeof pushed !== 'string') {
      return pushed;
    }
    const gate = await checkGate(job, pushed);
    if (gate.done) {
      return gate;
    }
    if (!gate.fixed) {
      return finishDone(job);
    }
  }
}

async function pushChange(job: Run): Promise<Finished | string> {
  const { context, log, state, worktree } = job;
  const { repo, config, ports, base } = context;
  for (let attempt = 1; ; attempt += 1) {
    const rebased = await rebase(job);
    if (rebased !== undefined) {
      return rebased;
    }
    const sha = await ports.revision(worktree);
    const pushed = await log.step('land', { base, sha }, () =>
      ports.pushToBase(worktree, config.remote, base),
    );
    if (pushed) {
      state.landed = [...(state.landed ?? []), sha];
      await writeState(repo, state);
      job.repairing = false;
      return sha;
    }
    if (attempt >= PUSH_TRIES) {
      return escalateAndFinish(
        job,
        `The push to ${base} failed ${PUSH_TRIES} times.`,
        'push failed',
      );
    }
  }
}
