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

/** Whether anything of this issue is, or may be, on the base with unknown checks. */
export function holdsOnBase(state: IssueState): boolean {
  return heldOnBase(state, '') !== '';
}

/** What a halt with an unchecked commit on the base means for the next runs. */
export const HALT_NOTE =
  'The run halts, and no run lands another change until this issue resumes (after an answer or once the label is off) and checks the base, or a person with write access gives it up with the skip label.';

/** Whether this state keeps every run from landing: it halted with a commit on the base whose checks are still unknown. */
export function blocksLanding(state: IssueState, base: string): boolean {
  return state.halted === true && state.closing !== true && heldOnBase(state, base) !== '';
}

/** Drops a saved halt once nothing of this issue is, or may be, on the base with unknown checks. */
export function releaseSettled(state: IssueState): void {
  if (!holdsOnBase(state)) {
    delete state.halted;
  }
}

export function unsettledNote(held: string, step: string): string {
  return ` ${step} before it checked the base: ${held}, and its checks were not awaited. ${HALT_NOTE}`;
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
