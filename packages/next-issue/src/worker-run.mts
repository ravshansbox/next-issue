import { type RunChildren, runChildren, stopRunChildren } from './children.mts';
import { wakeableSleep } from './durations.mts';
import type { Interrupts } from './interrupt.mts';
import type { Fields } from './observe.mts';
import { applyEvent } from './progress.mts';
import { type Progress, STOP_POINTS, type StopPoint, type WorkerMessage } from './protocol.mts';
import type { RunControls } from './run.mts';

export type Run = {
  progress: Progress;
  stop?: StopPoint;
  children: RunChildren;
  wake?: () => void;
};

export function newRun(progress: Progress): Run {
  return { progress, children: runChildren() };
}

export function active(run: Run | undefined): boolean {
  return run?.progress.status === 'running' || run?.progress.status === 'stopping';
}

export function endStatus(run: Run): Progress['status'] {
  if (run.stop !== undefined) {
    return 'stopped';
  }
  return run.progress.error === undefined ? 'finished' : 'failed';
}

export function startRefusal(run: Run | undefined, restart: boolean): string | undefined {
  if (restart) {
    return 'the worker is restarting, try again soon';
  }
  if (active(run)) {
    return 'a run is going in this repository already';
  }
  return undefined;
}

export function runsMessage(runs: Map<string, Run>): WorkerMessage {
  return {
    type: 'runs',
    runs: Object.fromEntries([...runs].map(([root, run]) => [root, run.progress])),
  };
}

function endsIssue(record: Fields): boolean {
  return record['kind'] === 'issue.end' || record['kind'] === 'issue.error';
}

export function stopPoint(after: unknown): StopPoint | undefined {
  return STOP_POINTS.find((point) => point === (after ?? 'issue'));
}

function earlier(after: StopPoint, than: StopPoint | undefined): boolean {
  return than === undefined || STOP_POINTS.indexOf(after) > STOP_POINTS.indexOf(than);
}

export function requestStop(run: Run | undefined, after: StopPoint): boolean {
  if (run === undefined || !active(run) || !earlier(after, run.stop)) {
    return false;
  }
  run.stop = after;
  run.wake?.();
  if (after === 'now') {
    stopRunChildren(run.children);
  }
  run.progress = { ...run.progress, status: 'stopping' };
  return true;
}

function runInterrupts(run: Run): Interrupts {
  return {
    afterIssue: () => run.stop !== undefined,
    afterRound: () => run.stop === 'round' || run.stop === 'now',
    sleep: (ms) => wakeableSleep(run, ms, run.stop !== undefined),
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
