import { type RunChildren, runChildren, stopRunChildren } from '../shared/children.mts';
import { wakeableSleep } from '../shared/durations.mts';
import { type Toggle, onOff } from '../shared/switch.mts';
import type { Interrupts } from '../shared/interrupt.mts';
import { applyEvent } from './progress.mts';
import {
  going,
  type Progress,
  STOP_POINTS,
  type StopPoint,
  type Upgrade,
  type WorkerMessage,
} from '../shared/protocol.mts';
import type { RunControls } from './run.mts';

export type Run = {
  progress: Progress;
  stop?: StopPoint;
  stoppedByPerson?: boolean;
  upgradeCancelled?: boolean;
  children: RunChildren;
  wake?: () => void;
  lookNow: AbortController;
  huntBusy?: () => boolean;
  watching: Toggle;
  hunting: Toggle;
  log?: { file: string; runId: string };
};

export function newRun(progress: Progress): Run {
  return {
    progress,
    children: runChildren(),
    lookNow: new AbortController(),
    watching: onOff(progress.watching === true),
    hunting: onOff(progress.hunting),
  };
}

export function active(run: Run | undefined): boolean {
  return going(run?.progress);
}

export function endStatus(run: Run): Progress['status'] {
  if (run.progress.error !== undefined) {
    return 'failed';
  }
  return run.stop === undefined ? 'finished' : 'stopped';
}

export function startRefusal(
  run: Run | undefined,
  restart: boolean,
  closing: boolean,
): string | undefined {
  if (restart) {
    return 'the worker is restarting, try again soon';
  }
  if (closing) {
    return 'the worker is shutting down, try again soon';
  }
  if (active(run)) {
    return 'a run is going in this repository already';
  }
  return undefined;
}

export function runsMessage(runs: Map<string, Run>, id?: string): WorkerMessage {
  return {
    type: 'runs',
    runs: Object.fromEntries([...runs].map(([root, run]) => [root, run.progress])),
    ...(id === undefined ? {} : { id }),
  };
}

export function joinRun(run: Run, given: { watch?: boolean; hunt?: boolean }): string | undefined {
  if (run.stoppedByPerson === true) {
    return 'the run is stopping';
  }
  if (given.watch !== undefined) {
    setWatching(run, given.watch);
  }
  if (given.hunt !== undefined) {
    setHunting(run, given.hunt);
  }
  run.lookNow.abort();
  run.lookNow = new AbortController();
  return undefined;
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
    hunting: run.huntBusy?.() === true,
    ...(id === undefined ? {} : { id }),
  };
}

export function requestUpgrade(run: Run, upgrade: Upgrade, everyRun = false): boolean {
  if (
    !active(run) ||
    (!run.watching.on() && (!everyRun || run.upgradeCancelled === true)) ||
    run.stoppedByPerson === true ||
    run.progress.upgrade !== undefined
  ) {
    return false;
  }
  requestStop(run, 'issue');
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

export function switchRefusal(run: Run | undefined, on: boolean): string | undefined {
  if (!active(run)) {
    return 'no run is going in this repository';
  }
  return on && run!.stoppedByPerson === true ? 'the run is stopping' : undefined;
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
    if (dropUpgrade(run)) {
      run.upgradeCancelled = true;
      run.stop = undefined;
      run.progress = { ...run.progress, status: 'running' };
    }
  }
  run.watching.set(on);
  run.progress = { ...run.progress, watching: on, hunting: run.hunting.on() };
}

function runInterrupts(run: Run): Interrupts {
  return {
    afterIssue: () => run.stop !== undefined,
    afterRound: () => run.stop === 'round' || run.stop === 'now',
    sleep: (ms, woken) => {
      return wakeableSleep(run, ms, run.stop !== undefined, woken);
    },
  };
}

export function runControls(run: Run, update: (next: Progress) => void): RunControls {
  return {
    interrupts: runInterrupts(run),
    hunting: run.hunting,
    watching: run.watching,
    lookNow: () => run.lookNow.signal,
    onEvent: (record) => {
      if (record['kind'] === 'run.start') {
        run.log = { file: String(record['log']), runId: String(record['runId']) };
      }
      update(applyEvent(run.progress, record));
    },
    onHunter: (busy) => {
      run.huntBusy = busy;
    },
  };
}
