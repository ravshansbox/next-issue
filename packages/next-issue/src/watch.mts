import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import type { IssueReport } from './job.mts';
import { handled, type Loop, type LoopResult, runIssues } from './loop.mts';

export type Hunter = {
  cap: number;
  ready: () => Promise<Issue[]>;
  hunt: (count: number) => Promise<boolean>;
  wait: (minutes: number, signal: AbortSignal) => Promise<void>;
};

export type Watch = Loop & {
  wait: (minutes: number) => Promise<boolean>;
  passEnd: (reports: IssueReport[]) => Promise<void>;
  hunter?: Hunter;
};

const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export async function watchIssues(
  args: Pick<Args, 'max' | 'once'>,
  watch: Watch,
): Promise<LoopResult> {
  const running = new Set<number>();
  const ended = new AbortController();
  const claims = claimAlarm();
  const hunting =
    watch.hunter === undefined
      ? undefined
      : huntIssues(
          watch.hunter,
          running,
          claims,
          () => ended.signal.aborted || watch.stop(),
          ended.signal,
        );
  try {
    return await watchPasses(args, {
      ...watch,
      process: async (issue) => {
        running.add(issue.number);
        claims.ring();
        try {
          return await watch.process(issue);
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

async function huntIssues(
  hunter: Hunter,
  running: Set<number>,
  claims: ClaimAlarm,
  stopped: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  let step = 0;
  while (!stopped()) {
    const ready = await hunter.ready().catch(() => undefined);
    claims.take();
    const waiting = ready?.filter((issue) => !running.has(issue.number)).length;
    if (waiting !== undefined && waiting < hunter.cap) {
      if (await hunter.hunt(hunter.cap - waiting)) {
        step = 0;
        continue;
      }
    }
    if (claims.take() || stopped()) {
      continue;
    }
    await hunter.wait(backOffMinutes(step), AbortSignal.any([signal, claims.signal()]));
    if (!claims.take()) {
      step += 1;
    }
  }
}

async function watchPasses(args: Pick<Args, 'max' | 'once'>, watch: Watch): Promise<LoopResult> {
  const limit = args.once ? 1 : args.max;
  const reports: IssueReport[] = [];
  const failed = new Set<number>();
  let step = 0;
  for (;;) {
    const pass = await runIssues(
      { once: false, max: limit === undefined ? undefined : limit - handled(reports) },
      watch,
      new Set(failed),
    );
    reports.push(...pass.reports);
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
    if (!(await watch.wait(minutes))) {
      return { reports };
    }
  }
}

function recordFailures(failed: Set<number>, reports: IssueReport[]): void {
  for (const report of reports) {
    if (report.outcome === 'error') {
      failed.add(report.issue);
    }
  }
}

function backOffMinutes(step: number): number {
  return BACK_OFF_MINUTES[Math.min(step, BACK_OFF_MINUTES.length - 1)]!;
}
