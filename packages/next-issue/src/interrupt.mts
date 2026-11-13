import { stopChildren } from './children.mts';
import { type Sleeper, wakeableSleep } from './durations.mts';

export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  sleep: (ms: number, hunting?: () => boolean) => Promise<boolean>;
};

export function listenForInterrupts(say: (text: string) => void): Interrupts {
  let presses = 0;
  let lastPress = -Infinity;
  const sleeper: Sleeper = {};
  let hunting = (): boolean => false;
  const press = (): void => {
    const now = performance.now();
    if (now - lastPress < 100) {
      return;
    }
    lastPress = now;
    presses += 1;
    if (presses === 1 && sleeper.wake !== undefined) {
      say(
        hunting()
          ? 'Stopping after the current hunt. Press Ctrl-C twice more to stop now.'
          : 'Stopping now.',
      );
      sleeper.wake();
    } else if (presses === 1) {
      say('Stopping after the running issues. Press Ctrl-C again to stop after the current round.');
    } else if (presses === 2) {
      say('Stopping after the current round. Press Ctrl-C again to stop now.');
    } else {
      process.off('SIGINT', press);
      stopChildren('SIGINT');
    }
  };
  process.on('SIGINT', press);
  return {
    afterIssue: () => presses >= 1,
    afterRound: () => presses >= 2,
    sleep: (ms, busy = () => false) => {
      hunting = busy;
      return wakeableSleep(sleeper, ms, presses >= 1);
    },
  };
}
