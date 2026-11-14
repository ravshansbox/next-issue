import { runStopped } from './children.mts';
import { message } from './errors.mts';
import type { IssueState } from './state.mts';

/** What the state holds that is, or may be, on the base branch with checks nobody awaited. */
export function heldOnBase(state: IssueState, base: string): string {
  const { landed, pushing, reverting } = state;
  const name = `\`${base}\``;
  return [
    (landed ?? []).length > 0 ? `a landed commit is on ${name}` : '',
    pushing === undefined ? '' : `a push may be on ${name}`,
    reverting === undefined ? '' : `a revert may be on ${name}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

export function unsettledNote(held: string, step: string): string {
  return ` ${step} before it checked the base: ${held}, and its checks were not awaited. The run halts, and the next run checks the base again.`;
}

/** An error thrown on a resume before it settled the base, while a commit is or may be on it. */
export class UnsettledBase extends Error {
  readonly note: string;

  constructor(cause: unknown, held: string) {
    super(message(cause), { cause });
    this.note = unsettledNote(held, 'This resume failed');
  }
}

/** Runs a step of a resume that comes before the base is settled; its error halts the run when the state holds a commit on the base. */
export async function beforeBaseSettled<T>(
  state: IssueState,
  base: string,
  step: () => Promise<T>,
): Promise<T> {
  const held = heldOnBase(state, base);
  try {
    return await step();
  } catch (error) {
    if (held === '' || runStopped() || error instanceof UnsettledBase) {
      throw error;
    }
    throw new UnsettledBase(error, held);
  }
}
