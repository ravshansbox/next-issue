import { runStopped } from './children.mts';
import { message } from './errors.mts';
import type { IssueState } from './state.mts';

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

function holdsOnBase(state: IssueState): boolean {
  return heldOnBase(state, '') !== '';
}

export const HALT_NOTE =
  'The run halts, and no run lands another change until this issue resumes (after an answer or once the label is off) and checks the base, or a person with write access gives it up with the skip label.';

export function blocksLanding(state: IssueState, base: string): boolean {
  return state.halted === true && state.closing !== true && heldOnBase(state, base) !== '';
}

export function releaseSettled(state: IssueState): void {
  if (!holdsOnBase(state)) {
    delete state.halted;
  }
}

export function unsettledNote(held: string, step: string): string {
  return ` ${step} before it checked the base: ${held}, and its checks were not awaited. ${HALT_NOTE}`;
}

export class UnsettledBase extends Error {
  readonly note: string;

  constructor(cause: unknown, held: string) {
    super(message(cause), { cause });
    this.note = unsettledNote(held, 'This resume failed');
  }
}

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
