import { type RunChildren, runChildren, stopRunChildren } from './children.mts';
import { wakeableSleep } from './durations.mts';
import { type Toggle, onOff } from './switch.mts';
import type { Interrupts } from './interrupt.mts';
import type { Fields } from './observe.mts';
import { applyEvent } from './progress.mts';
import {
  type Progress,
  STOP_POINTS,
  type StopPoint,
  type Upgrade,
  type WorkerMessage,
} from './protocol.mts';
import { type Refresher, refresher } from './refresh.mts';
import type { RunControls } from './run.mts';

export type Run = {
  progress: Progress;
  stop?: StopPoint;
  children: RunChildren;
  wake?: () => void;
  huntBusy?: () => boolean;
  watching: Toggle;
  hunting: Toggle;
  refresher: Refresher;
};

export function newRun(progress: Progress): Run {
  return {
    progress,
    children: runChildren(),
    watching: onOff(progress.watching === true),
    hunting: onOff(progress.hunting),
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

export function stoppingMessage(root: string, run: Run, id?: string): WorkerMessage {
  const waiting = run.wake !== undefined;
  return {
    type: 'stopping',
    root,
    waiting,
    hunting: waiting && run.huntBusy?.() === true,
    ...(id === undefined ? {} : { id }),
  };
}

export function requestUpgrade(run: Run, upgrade: Upgrade): boolean {
  if (!run.watching.on() || run.stop !== undefined || !requestStop(run, 'issue')) {
    return false;
  }
  run.progress = { ...run.progress, upgrade };
  return true;
}

export function dropUpgrade(run: Run | undefined): boolean {
  if (run?.progress.upgrade === undefined) {
    return false;
  }
  run.progress = { ...run.progress, upgrade: undefined };
  return true;
}

export function switchRefusal(run: Run | undefined): string | undefined {
  return active(run) ? undefined : 'no run is going in this repository';
}

// Only a running watch run refreshes; a pass that is going or a stop is left alone.
export function requestRefresh(run: Run | undefined): boolean {
  if (run?.progress.status !== 'running' || !run.watching.on() || run.stop !== undefined) {
    return false;
  }
  run.refresher.refresh();
  return true;
}

export function setHunting(run: Run, on: boolean): void {
  if (on) {
    run.watching.set(true);
  }
  run.hunting.set(on);
  run.progress = { ...run.progress, hunting: on, watching: run.watching.on() };
}

export function setWatching(run: Run, on: boolean): void {
  if (!on) {
    run.hunting.set(false);
    dropUpgrade(run);
  }
  run.watching.set(on);
  run.progress = { ...run.progress, watching: on, hunting: run.hunting.on() };
}

function runInterrupts(run: Run): Interrupts {
  return {
    afterIssue: () => run.stop !== undefined,
    afterRound: () => run.stop === 'round' || run.stop === 'now',
    sleep: (ms, hunting, refreshed) => {
      run.huntBusy = hunting;
      return wakeableSleep(run, ms, run.stop !== undefined, refreshed);
    },
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
    watching: run.watching,
    refreshed: run.refresher.refreshed,
    onEvent: (record) => {
      update(applyEvent(run.progress, record));
      if (endsIssue(record)) {
        issueEnded();
      }
    },
  };
}
