import { stopChildren } from './children.mts';
import { type Sleeper, wakeableSleep } from './durations.mts';

export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  // A sleep also ends (false) when `refreshed` aborts.
  sleep: (ms: number, hunting?: () => boolean, refreshed?: AbortSignal) => Promise<boolean>;
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

export function listenForInterrupts(say: (text: string) => void): Interrupts {
  let presses = 0;
  const sleeper: Sleeper = {};
  let hunting = (): boolean => false;
  const stopListening = onPresses((count) => {
    presses = count;
    if (presses === 1 && sleeper.wake !== undefined) {
      say(hunting() ? NOTES.hunt : NOTES.wait);
      sleeper.wake();
    } else if (presses === 1) {
      say(NOTES.issue);
    } else if (presses === 2) {
      say(NOTES.round);
    } else {
      stopListening();
      stopChildren('SIGINT');
    }
  });
  return {
    afterIssue: () => presses >= 1,
    afterRound: () => presses >= 2,
    sleep: (ms, busy = () => false, refreshed) => {
      hunting = busy;
      return wakeableSleep(sleeper, ms, presses >= 1, refreshed);
    },
  };
}
