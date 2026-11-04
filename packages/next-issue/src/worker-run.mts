import type { Interrupts } from './interrupt.mts';
import type { Fields } from './observe.mts';
import { applyEvent } from './progress.mts';
import type { Progress } from './protocol.mts';
import type { RunControls } from './run.mts';

export type Run = {
  progress: Progress;
  stop: boolean;
  wake?: () => void;
};

export function active(run: Run | undefined): boolean {
  return run?.progress.status === 'running' || run?.progress.status === 'stopping';
}

export function endStatus(run: Run): Progress['status'] {
  if (run.stop) {
    return 'stopped';
  }
  return run.progress.error === undefined ? 'finished' : 'failed';
}

export function startRefusal(run: Run | undefined, restart: boolean): string | undefined {
  if (active(run)) {
    return 'a run is going in this repository already';
  }
  if (restart) {
    return 'the worker is restarting, try again soon';
  }
  return undefined;
}

function endsIssue(record: Fields): boolean {
  return record['kind'] === 'issue.end' || record['kind'] === 'issue.error';
}

export function requestStop(run: Run): void {
  run.stop = true;
  run.wake?.();
  run.progress = { ...run.progress, status: 'stopping' };
}

function runInterrupts(run: Run): Interrupts {
  return {
    afterIssue: () => run.stop,
    afterRound: () => run.stop,
    sleep: (ms) =>
      new Promise((resolve) => {
        if (run.stop) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => resolve(true), ms);
        run.wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      }),
  };
}

export function runControls(
  run: Run,
  update: (next: Progress) => void,
  issueEnded: () => void,
): RunControls {
  return {
    interrupts: runInterrupts(run),
    onEvent: (record) => {
      update(applyEvent(run.progress, record));
      if (endsIssue(record)) {
        issueEnded();
      }
    },
  };
}
