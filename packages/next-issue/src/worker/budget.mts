import { onKill, runStopped } from '../shared/children.mts';
import { escalateAndFinish } from '../shared/handover.mts';
import type { Finished, Run } from '../shared/job.mts';
import { writeState, writeStateNow } from '../shared/state.mts';

const LIMITS = {
  ciFixes: 'maxCiFixes',
  commitFixes: 'maxCommitFixes',
  reviewRounds: 'maxReviewRounds',
} as const;

type Budget = keyof typeof LIMITS;

export type BudgetUse = { round: number; limit: number };

export function budgetUse(job: Run, budget: Budget): BudgetUse {
  return { round: job.state[budget] ?? 0, limit: job.context.config[LIMITS[budget]] };
}

export async function spendBudget(
  job: Run,
  budget: Budget,
  note: string,
  reason: string,
  beforeHandOver?: () => Promise<string | void>,
): Promise<Finished | undefined> {
  const { context, state } = job;
  const { round, limit } = budgetUse(job, budget);
  if (round >= limit) {
    const after = (await beforeHandOver?.()) ?? '';
    return escalateAndFinish(job, `${note}${after}`, reason);
  }
  state[budget] = (state[budget] ?? 0) + 1;
  await writeState(context.repo, state);
  return undefined;
}

async function refundBudget(job: Run, budget: Budget): Promise<void> {
  const { context, state } = job;
  state[budget] = Math.max(0, (state[budget] ?? 0) - 1);
  await writeState(context.repo, state);
}

/** Gives the spent budget back if the worker is killed or the run is stopped while `body` runs. */
export async function refundIfCut<T>(
  job: Run,
  budget: Budget,
  body: () => Promise<T>,
  undo?: () => void,
): Promise<T> {
  const { context, state } = job;
  let refunded = false;
  const forget = onKill(() => {
    refunded = true;
    undo?.();
    state[budget] = Math.max(0, (state[budget] ?? 0) - 1);
    writeStateNow(context.repo, state);
  });
  try {
    try {
      return await body();
    } finally {
      forget();
    }
  } catch (error) {
    if (runStopped() && !refunded) {
      undo?.();
      await refundBudget(job, budget);
    }
    throw error;
  }
}
