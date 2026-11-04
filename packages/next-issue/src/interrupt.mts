import { stopChildren } from './children.mts';

export type Interrupts = {
  afterIssue: () => boolean;
  afterRound: () => boolean;
  sleep: (ms: number) => Promise<boolean>;
};

type Sleeper = { wake?: () => void };

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
