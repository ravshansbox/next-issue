export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  // A sleep also ends (false) when `woken` aborts.
  sleep: (ms: number, hunting?: () => boolean, woken?: AbortSignal) => Promise<boolean>;
};

export const NOTES = {
  hunt: 'Stopping after the current hunt. Press Ctrl-C twice more to stop now.',
  wait: 'Stopping now.',
  issue: 'Stopping after the running issues. Press Ctrl-C again to stop after the current round.',
  round: 'Stopping after the current round. Press Ctrl-C again to stop now.',
};

export function onPresses(handle: (presses: number) => void): () => void {
  let presses = 0;
  let lastPress = -Infinity;
  let ending: NodeJS.Timeout | undefined;
  const press = (): void => {
    const now = performance.now();
    if (now - lastPress < 100) {
      return;
    }
    lastPress = now;
    presses += 1;
    if (presses >= 3) {
      ending = setTimeout(() => process.off('SIGINT', press), 100).unref();
    }
    handle(presses);
  };
  process.on('SIGINT', press);
  return () => {
    clearTimeout(ending);
    process.off('SIGINT', press);
  };
}
