import { escalateAndFinish } from './handover.mts';
import type { Finished, Run } from './job.mts';
import { writeState } from './state.mts';

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
