import type { Args } from './args.mts';
import type { IssueReport } from './job.mts';
import { handled, type Loop, type LoopResult, runIssues } from './loop.mts';

export type Watch = Loop & {
  wait: (minutes: number) => Promise<boolean>;
  passEnd: (reports: IssueReport[]) => Promise<void>;
  hunt?: () => Promise<void>;
};

const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export async function watchIssues(
  args: Pick<Args, 'max' | 'once'>,
  watch: Watch,
): Promise<LoopResult> {
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
    await watch.hunt?.();
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
