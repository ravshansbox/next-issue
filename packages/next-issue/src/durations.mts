export function minutesToMs(minutes: number): number {
  return minutes * 60_000;
}

export function daysToMs(days: number): number {
  return minutesToMs(days * 24 * 60);
}

export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

export type Deadline = {
  timedOut: () => boolean;
  clear: () => void;
};

export function deadline(ms: number | undefined, onExpire: () => void): Deadline {
  let timedOut = false;
  const timer =
    ms === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          onExpire();
        }, ms);
  return { timedOut: () => timedOut, clear: () => clearTimeout(timer) };
}

export function elapsedMs(started: number): number {
  return Date.now() - started;
}

export type Sleeper = { wake?: () => void };

export function wakeableSleep(sleeper: Sleeper, ms: number, stopped: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (stopped) {
      resolve(false);
      return;
    }
    const settle = (slept: boolean): void => {
      clearTimeout(timer);
      sleeper.wake = undefined;
      resolve(slept);
    };
    const timer = setTimeout(() => settle(true), ms);
    sleeper.wake = () => settle(false);
  });
}
