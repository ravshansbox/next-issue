import { stopChildren } from './children.mts';
import { type Sleeper, wakeableSleep } from './durations.mts';

export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  sleep: (ms: number) => Promise<boolean>;
};

export function listenForInterrupts(say: (text: string) => void): Interrupts {
  let presses = 0;
  const sleeper: Sleeper = {};
  const press = (): void => {
    presses += 1;
    if (presses === 1 && sleeper.wake !== undefined) {
      say('Stopping now.');
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
    sleep: (ms) => wakeableSleep(sleeper, ms, presses >= 1),
  };
}
