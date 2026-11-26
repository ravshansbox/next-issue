import { setTimeout as delay } from 'node:timers/promises';
import { onStop, runStopped } from './children.mts';
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
  sleep: (ms) => sleepUntilStopped(ms),
};

async function sleepUntilStopped(ms: number): Promise<void> {
  if (runStopped()) {
    return;
  }
  const controller = new AbortController();
  const forget = onStop(() => controller.abort());
  try {
    await delay(ms, undefined, { signal: controller.signal });
  } catch {
  } finally {
    forget();
  }
}

export function pause(clock: Clock, options: Polling, rest: number): Promise<void> {
  return clock.sleep(timerMs(Math.min(secondsToMs(options.intervalSeconds), rest)));
}
