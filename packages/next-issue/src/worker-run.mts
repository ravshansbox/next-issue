import { type RunChildren, runChildren, stopRunChildren } from './children.mts';
import { wakeableSleep } from './durations.mts';
import { type HuntToggle, huntSwitch } from './hunt-switch.mts';
import type { Interrupts } from './interrupt.mts';
import type { Fields } from './observe.mts';
import { applyEvent } from './progress.mts';
import { type Progress, STOP_POINTS, type StopPoint, type WorkerMessage } from './protocol.mts';
import { type Refresher, refresher } from './refresh.mts';
import type { RunControls } from './run.mts';

export type Run = {
  progress: Progress;
  stop?: StopPoint;
  children: RunChildren;
  wake?: () => void;
  watching: boolean;
  hunting: HuntToggle;
  refresher: Refresher;
};

export function newRun(progress: Progress, watching = false): Run {
  return {
    progress,
    children: runChildren(),
    watching,
    hunting: huntSwitch(progress.hunting),
    refresher: refresher(),
  };
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

export function huntRefusal(run: Run | undefined, on: boolean): string | undefined {
  if (run === undefined || !active(run)) {
    return 'no run is going in this repository';
  }
  if (on && !run.watching) {
    return 'the run does not watch for issues, so it cannot hunt: start a run with --watch or --hunt';
  }
  return undefined;
}

// Only a running watch run refreshes; a pass that is going or a stop is left alone.
export function requestRefresh(run: Run | undefined): boolean {
  if (run?.progress.status !== 'running' || !run.watching || run.stop !== undefined) {
    return false;
  }
  run.refresher.refresh();
  return true;
}

export function setHunting(run: Run, on: boolean): void {
  run.hunting.set(on);
  run.progress = { ...run.progress, hunting: on };
}

function runInterrupts(run: Run): Interrupts {
  return {
    afterIssue: () => run.stop !== undefined,
    afterRound: () => run.stop === 'round' || run.stop === 'now',
    sleep: (ms, _hunting, refreshed) => wakeableSleep(run, ms, run.stop !== undefined, refreshed),
  };
}

export function runControls(
  run: Run,
  update: (next: Progress) => void,
  issueEnded: () => void,
): RunControls {
  return {
    interrupts: runInterrupts(run),
    hunting: run.hunting,
    refreshed: run.refresher.refreshed,
    onEvent: (record) => {
      update(applyEvent(run.progress, record));
      if (endsIssue(record)) {
        issueEnded();
      }
    },
  };
}
