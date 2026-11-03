import { stopChildren } from './exec.mts';

export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  sleep: (ms: number) => Promise<boolean>;
};

export function listenForInterrupts(say: (text: string) => void): Interrupts {
  let presses = 0;
  let wake: (() => void) | undefined;
  const press = (): void => {
    presses += 1;
    if (presses === 1 && wake !== undefined) {
      say('Stopping now.');
      wake();
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
    sleep: (ms) =>
      new Promise((resolve) => {
        if (presses >= 1) {
          resolve(false);
          return;
        }
        const settle = (slept: boolean): void => {
          clearTimeout(timer);
          wake = undefined;
          resolve(slept);
        };
        const timer = setTimeout(() => settle(true), ms);
        wake = () => settle(false);
      }),
  };
}
