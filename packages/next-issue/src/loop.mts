import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import type { IssueReport } from './pipeline.mts';

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue) => Promise<IssueReport>;
  stop: () => boolean;
  concurrency?: number;
};

export type Watch = Loop & {
  wait: (minutes: number) => Promise<boolean>;
  passEnd: (reports: IssueReport[]) => Promise<void>;
};

export const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export type LoopResult = { reports: IssueReport[]; stoppedAt?: number; error?: unknown };

export async function runIssues(
  args: Pick<Args, 'max' | 'once'>,
  loop: Loop,
  seen = new Set<number>(),
): Promise<LoopResult> {
  const limit = args.once ? Math.min(1, args.max ?? 1) : args.max;
  const concurrency = loop.concurrency ?? 1;
  const reports: IssueReport[] = [];
  const running = new Map<
    number,
    Promise<{ issue: number; report?: IssueReport; failure?: unknown }>
  >();
  let stoppedAt: number | undefined;
  let error: unknown;
  let crash: { failure: unknown } | undefined;
  let claiming = true;
  const room = (): boolean =>
    running.size < concurrency && (limit === undefined || handled(reports) + running.size < limit);
  for (;;) {
    if (claiming && room()) {
      try {
        const issues = await loop.issues();
        for (const issue of issues.filter((candidate) => !seen.has(candidate.number))) {
          if (!room()) {
            break;
          }
          seen.add(issue.number);
          running.set(
            issue.number,
            loop.process(issue).then(
              (report) => ({ issue: issue.number, report }),
              (failure: unknown) => ({ issue: issue.number, failure }),
            ),
          );
        }
      } catch (failure) {
        error = failure;
        claiming = false;
      }
    }
    if (running.size === 0) {
      break;
    }
    const { issue, report, failure } = await Promise.race(running.values());
    running.delete(issue);
    if (report === undefined) {
      crash ??= { failure };
      claiming = false;
      continue;
    }
    reports.push(report);
    if (claiming && (loop.stop() || report.halt === true)) {
      stoppedAt = issue;
      claiming = false;
    }
  }
  if (crash !== undefined) {
    throw crash.failure;
  }
  return {
    reports,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

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
    for (const report of pass.reports) {
      if (report.outcome === 'error') {
        failed.add(report.issue);
      }
    }
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
    const minutes = BACK_OFF_MINUTES[Math.min(step, BACK_OFF_MINUTES.length - 1)]!;
    step += 1;
    if (!(await watch.wait(minutes))) {
      return { reports };
    }
  }
}

export function exitCode(reports: IssueReport[]): number {
  return reports.some((report) => report.outcome === 'needs-human' || report.outcome === 'error')
    ? 1
    : 0;
}

function handled(reports: IssueReport[]): number {
  return reports.filter((report) => report.outcome !== 'skipped').length;
}
