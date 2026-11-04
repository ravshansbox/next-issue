import { setTimeout as delay } from 'node:timers/promises';

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
  return clock.sleep(Math.min(options.intervalSeconds * 1000, rest));
}

export async function pollUntil<T>(
  options: Polling,
  clock: Clock,
  probe: () => Promise<T>,
  settled: (value: T) => boolean,
): Promise<T> {
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    const rest = deadline - clock.now();
    if (settled(value) || rest <= 0) {
      return value;
    }
    await pause(clock, options, rest);
  }
}
