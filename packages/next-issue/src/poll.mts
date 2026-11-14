import { setTimeout as delay } from 'node:timers/promises';
import { secondsToMs, timerMs } from './durations.mts';

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type Polling = {
  intervalSeconds: number;
  timeoutMs: number;
};

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
};

export function pause(clock: Clock, options: Polling, rest: number): Promise<void> {
  return clock.sleep(timerMs(Math.min(secondsToMs(options.intervalSeconds), rest)));
}
