import type { Config } from './config.mts';
import { refuseWhenStopped } from './children.mts';
import { minutesToMs, secondsToMs } from './durations.mts';
import { asError, errorMatches } from './errors.mts';
import { type Clock, type Polling, pause, REAL_CLOCK } from './poll.mts';

export type CheckState =
  | 'pass'
  | 'fail'
  | 'pending'
  | 'none'
  | 'timeout'
  | 'limited'
  | 'cancelled'
  | 'cut';

const READ_TRIES = 3;
const RATE_LIMIT = /rate limit|HTTP 429/i;
const RATE_LIMIT_WAIT_MS = 60_000;

export type ChecksProbe = {
  list: () => Promise<'none' | 'some'>;
  watch: (timeoutMs: number) => Promise<CheckState>;
};

export type PollOptions = Polling & {
  graceMs: number;
};

export function checkWaiting(config: Config, grace: boolean): PollOptions {
  return {
    intervalSeconds: config.checkIntervalSeconds,
    timeoutMs: minutesToMs(config.checkTimeoutMinutes),
    graceMs: grace ? secondsToMs(config.checkGraceSeconds) : 0,
  };
}

export async function pollChecks(
  probe: ChecksProbe,
  options: PollOptions,
  clock: Clock = REAL_CLOCK,
): Promise<CheckState> {
  const deadline = clock.now() + options.timeoutMs;
  const rest = (): number => Math.max(0, deadline - clock.now());
  let shown: number | undefined;
  let failures = 0;
  let last: CheckState | Error | undefined;
  for (;;) {
    refuseWhenStopped();
    if (rest() === 0) {
      if (errorMatches(last, RATE_LIMIT)) {
        return 'limited';
      }
      return last === 'pass' || last === 'none' ? last : 'timeout';
    }
    const state = await read(probe, rest(), () => (shown ??= clock.now()));
    last = state;
    if (errorMatches(state, RATE_LIMIT)) {
      failures = 0;
      await clock.sleep(Math.min(RATE_LIMIT_WAIT_MS, rest()));
      continue;
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

function settled(state: CheckState, waitedMs: number, graceMs: number): CheckState | undefined {
  if (state === 'none' || state === 'pass') {
    return waitedMs >= graceMs ? state : undefined;
  }
  return state === 'pending' ? undefined : state;
}

async function read(
  probe: ChecksProbe,
  timeoutMs: number,
  shown: () => void,
): Promise<CheckState | Error> {
  try {
    shown();
    if ((await probe.list()) === 'none') {
      return 'none';
    }
    return await probe.watch(timeoutMs);
  } catch (error) {
    return asError(error);
  }
}
