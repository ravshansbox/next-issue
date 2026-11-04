export function minutesToMs(minutes: number): number {
  return minutes * 60_000;
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
