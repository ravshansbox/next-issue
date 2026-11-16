import { onKill } from './children.mts';
import { escalateAndFinish } from './handover.mts';
import type { Finished, Run } from './job.mts';
import { writeState, writeStateNow } from './state.mts';

const LIMITS = { ciFixes: 'maxCiFixes', reviewRounds: 'maxReviewRounds' } as const;

type Budget = keyof typeof LIMITS;

export type BudgetUse = { round: number; limit: number };

export function budgetUse(job: Run, budget: Budget): BudgetUse {
  return { round: job.state[budget], limit: job.context.config[LIMITS[budget]] };
}

export async function spendBudget(
  job: Run,
  budget: Budget,
  note: string,
  reason: string,
  beforeHandOver?: () => Promise<void>,
): Promise<Finished | undefined> {
  const { context, state } = job;
  const { round, limit } = budgetUse(job, budget);
  if (round >= limit) {
    await beforeHandOver?.();
    return escalateAndFinish(job, note, reason);
  }
  state[budget] += 1;
  await writeState(context.repo, state);
  return undefined;
}

export async function refundBudget(job: Run, budget: Budget): Promise<void> {
  const { context, state } = job;
  state[budget] = Math.max(0, state[budget] - 1);
  await writeState(context.repo, state);
}

/** Gives the spent budget back if the process is killed (third Ctrl-C) while `body` runs. */
export async function refundOnKill<T>(
  job: Run,
  budget: Budget,
  body: () => Promise<T>,
  undo?: () => void,
): Promise<T> {
  const { context, state } = job;
  const forget = onKill(() => {
    undo?.();
    state[budget] = Math.max(0, state[budget] - 1);
    writeStateNow(context.repo, state);
  });
  try {
    return await body();
  } finally {
    forget();
  }
}
