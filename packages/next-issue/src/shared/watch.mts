import type { Issue } from './github.mts';
import { type Switch, onOff } from './switch.mts';
import type { IssueReport } from './job.mts';
import { handled, type Loop, type LoopResult, runIssues } from './loop.mts';

export type Hunter = {
  cap: number;
  ready: (running: ReadonlySet<number>, failed: ReadonlySet<number>) => Promise<Issue[]>;
  hunt: (count: number) => Promise<boolean>;
  wait: (minutes: number, signal: AbortSignal) => Promise<void>;
};

export type Watch = Loop & {
  // `refreshed` aborts when a client asks for new issues; the wait then ends early.
  wait: (minutes: number, refreshed?: AbortSignal) => Promise<boolean>;
  passEnd: (reports: IssueReport[]) => Promise<void>;
  hunter?: Hunter;
  hunting?: Switch;
  // Off ends the watch after the current pass, or at once during a wait.
  watching?: Switch;
};

const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export async function watchIssues(watch: Watch): Promise<LoopResult> {
  const running = new Set<number>();
  const failed = new Set<number>();
  const ended = new AbortController();
  const hunting =
    watch.hunter === undefined
      ? undefined
      : huntIssues(
          watch.hunter,
          watch.hunting ?? onOff(true),
          running,
          failed,
          watch.issues,
          watch.refreshed,
          () => ended.signal.aborted || watch.stop(),
          ended.signal,
        );
  try {
    return await watchPasses(failed, {
      ...watch,
      process: async (issue, slot) => {
        running.add(issue.number);
        try {
          const report = await watch.process(issue, slot);
          recordFailures(failed, [report]);
          return report;
        } finally {
          running.delete(issue.number);
        }
      },
    });
  } finally {
    ended.abort();
    await hunting;
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }
  });
}

async function huntIssues(
  hunter: Hunter,
  hunting: Switch,
  running: Set<number>,
  failed: ReadonlySet<number>,
  issues: () => Promise<Issue[]>,
  refreshes: (() => AbortSignal) | undefined,
  stopped: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  let step = 0;
  while (!stopped()) {
    if (!hunting.on()) {
      await aborted(AbortSignal.any([signal, hunting.changed()]));
      step = 0;
      continue;
    }
    const ready = await hunter.ready(running, failed).catch(() => undefined);
    if (stopped()) {
      return;
    }
    const waiting = ready?.filter((issue) => !running.has(issue.number)).length;
    if (waiting !== undefined && waiting < hunter.cap && hunting.on()) {
      if (await hunter.hunt(hunter.cap - waiting)) {
        step = 0;
        await issues().catch(() => undefined);
      }
    }
    if (stopped() || !hunting.on()) {
      continue;
    }
    const changed = hunting.changed();
    const refreshed = refreshes?.() ?? new AbortController().signal;
    await hunter.wait(backOffMinutes(step), AbortSignal.any([signal, changed, refreshed]));
    if (changed.aborted || refreshed.aborted) {
      step = 0;
    } else {
      step += 1;
    }
  }
}

async function watchPasses(failed: Set<number>, watch: Watch): Promise<LoopResult> {
  const reports: IssueReport[] = [];
  let step = 0;
  const watching = (): boolean => watch.watching?.on() ?? true;
  for (;;) {
    const pass = await runIssues(watch, new Set(failed));
    addReports(reports, pass.reports);
    const { refreshed, ...result } = pass;
    if (pass.crash !== undefined) {
      return { ...result, reports };
    }
    recordFailures(failed, pass.reports);
    if (handled(pass.reports) > 0) {
      await watch.passEnd(pass.reports);
      step = 0;
    }
    if (pass.error !== undefined || pass.stoppedAt !== undefined) {
      return { ...result, reports };
    }
    if (watch.stop() || !watching()) {
      return { reports };
    }
    const minutes = backOffMinutes(step);
    step += 1;
    const signals = [refreshed ?? watch.refreshed?.(), watch.watching?.changed()].filter(
      (signal) => signal !== undefined,
    );
    const woken = signals.length === 0 ? undefined : AbortSignal.any(signals);
    if (!(await watch.wait(minutes, woken))) {
      if (woken?.aborted !== true || watch.stop() || !watching()) {
        return { reports };
      }
      step = 0;
    }
  }
}

function addReports(reports: IssueReport[], pass: IssueReport[]): void {
  for (const report of pass) {
    const skip = reports.findIndex(
      (entry) => entry.issue === report.issue && entry.outcome === 'skipped',
    );
    if (report.outcome !== 'skipped' && skip >= 0) {
      reports[skip] = report;
    } else if (
      report.outcome !== 'skipped' ||
      reports.every((entry) => entry.issue !== report.issue)
    ) {
      reports.push(report);
    }
  }
}

function recordFailures(failed: Set<number>, reports: IssueReport[]): void {
  for (const report of reports) {
    if (report.outcome === 'error' && report.handedOver !== true) {
      failed.add(report.issue);
    }
  }
}

function backOffMinutes(step: number): number {
  return BACK_OFF_MINUTES[Math.min(step, BACK_OFF_MINUTES.length - 1)]!;
}
