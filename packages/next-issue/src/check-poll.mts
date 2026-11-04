import { asError } from './gh.mts';
import { type Clock, type Polling, pause, REAL_CLOCK } from './poll.mts';

export type CheckState = 'pass' | 'fail' | 'pending' | 'none' | 'timeout' | 'moved';

const READ_TRIES = 3;

export type ChecksProbe = {
  head: () => Promise<string>;
  lags: (head: string) => Promise<boolean>;
  list: () => Promise<'none' | 'some'>;
  watch: (timeoutMs: number) => Promise<CheckState>;
};

export type PollOptions = Polling & {
  graceMs: number;
  head?: string;
};

export async function pollChecks(
  probe: ChecksProbe,
  options: PollOptions,
  clock: Clock = REAL_CLOCK,
): Promise<CheckState> {
  const deadline = clock.now() + options.timeoutMs;
  const rest = (): number => Math.max(0, deadline - clock.now());
  let shown: number | undefined;
  let failures = 0;
  for (;;) {
    if (rest() === 0) {
      return 'timeout';
    }
    const state = await read(probe, options.head, rest(), () => (shown ??= clock.now()));
    if (state === 'behind' && shown !== undefined) {
      return 'moved';
    }
    if (state instanceof Error) {
      failures += 1;
      if (failures >= READ_TRIES) {
        throw state;
      }
    } else {
      failures = 0;
      const outcome = settled(state, clock.now() - (shown ?? 0), options.graceMs);
      if (outcome !== undefined) {
        return outcome;
      }
    }
    await pause(clock, options, rest());
  }
}

function settled(
  state: CheckState | 'behind',
  waitedMs: number,
  graceMs: number,
): CheckState | undefined {
  if (state === 'none') {
    return waitedMs >= graceMs ? 'none' : undefined;
  }
  return state === 'behind' || state === 'pending' ? undefined : state;
}

async function read(
  probe: ChecksProbe,
  head: string | undefined,
  timeoutMs: number,
  shown: () => void,
): Promise<CheckState | 'behind' | Error> {
  try {
    if (head !== undefined) {
      const current = await probe.head();
      if (current !== head) {
        return (await probe.lags(current)) ? 'behind' : 'moved';
      }
    }
    shown();
    if ((await probe.list()) === 'none') {
      return 'none';
    }
    const state = await probe.watch(timeoutMs);
    if (head !== undefined && (await probe.head()) !== head) {
      return 'moved';
    }
    return state;
  } catch (error) {
    return asError(error);
  }
}
