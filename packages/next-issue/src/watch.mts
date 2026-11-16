import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import { type HuntSwitch, huntSwitch } from './hunt-switch.mts';
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
  hunting?: HuntSwitch;
  refreshed?: () => AbortSignal;
};

const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export async function watchIssues(
  args: Pick<Args, 'max' | 'once'>,
  watch: Watch,
): Promise<LoopResult> {
  const running = new Set<number>();
  const failed = new Set<number>();
  const ended = new AbortController();
  const claims = claimAlarm();
  const hunting =
    watch.hunter === undefined
      ? undefined
      : huntIssues(
          watch.hunter,
          watch.hunting ?? huntSwitch(true),
          running,
          failed,
          claims,
          watch.refreshed,
          () => ended.signal.aborted || watch.stop(),
          ended.signal,
        );
  try {
    return await watchPasses(args, failed, {
      ...watch,
      process: async (issue) => {
        running.add(issue.number);
        try {
          return await watch.process(issue, claims.ring);
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

type ClaimAlarm = {
  ring: () => void;
  take: () => boolean;
  signal: () => AbortSignal;
};

function claimAlarm(): ClaimAlarm {
  let rung = false;
  let controller = new AbortController();
  return {
    ring: () => {
      rung = true;
      controller.abort();
    },
    take: () => {
      const was = rung;
      rung = false;
      return was;
    },
    signal: () => {
      controller = new AbortController();
      return controller.signal;
    },
  };
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
  hunting: HuntSwitch,
  running: Set<number>,
  failed: ReadonlySet<number>,
  claims: ClaimAlarm,
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
    claims.take();
    const waiting = ready?.filter((issue) => !running.has(issue.number)).length;
    if (waiting !== undefined && waiting < hunter.cap && hunting.on()) {
      if (await hunter.hunt(hunter.cap - waiting)) {
        step = 0;
      }
    }
    if (claims.take() || stopped() || !hunting.on()) {
      continue;
    }
    const changed = hunting.changed();
    const refreshed = refreshes?.() ?? new AbortController().signal;
    await hunter.wait(
      backOffMinutes(step),
      AbortSignal.any([signal, claims.signal(), changed, refreshed]),
    );
    if (changed.aborted || refreshed.aborted) {
      step = 0;
    } else if (!claims.take()) {
      step += 1;
    }
  }
}

async function watchPasses(
  args: Pick<Args, 'max' | 'once'>,
  failed: Set<number>,
  watch: Watch,
): Promise<LoopResult> {
  const limit = args.once ? 1 : args.max;
  const reports: IssueReport[] = [];
  let step = 0;
  for (;;) {
    const pass = await runIssues(
      { once: false, max: limit === undefined ? undefined : limit - handled(reports) },
      watch,
      new Set(failed),
    );
    addReports(reports, pass.reports);
    recordFailures(failed, pass.reports);
    if (handled(pass.reports) > 0) {
      await watch.passEnd(pass.reports);
      step = 0;
    }
    if (pass.error !== undefined || pass.stoppedAt !== undefined) {
      return { ...pass, reports };
    }
    if ((limit !== undefined && handled(reports) >= limit) || watch.stop()) {
      return { reports };
    }
    const minutes = backOffMinutes(step);
    step += 1;
    const refreshed = watch.refreshed?.();
    if (!(await watch.wait(minutes, refreshed))) {
      if (refreshed?.aborted !== true || watch.stop()) {
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
