import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import type { IssueReport } from './pipeline.mts';

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue) => Promise<IssueReport>;
  stop: () => boolean;
};

export type Watch = Loop & {
  wait: (minutes: number) => Promise<boolean>;
  passEnd: (reports: IssueReport[]) => Promise<void>;
};

export const BACK_OFF_MINUTES = [1, 2, 3, 5, 10];

export type LoopResult = { reports: IssueReport[]; stoppedAt?: number; error?: unknown };

export async function runIssues(args: Pick<Args, 'max' | 'once'>, loop: Loop): Promise<LoopResult> {
  const reports: IssueReport[] = [];
  const seen = new Set<number>();
  while (args.max === undefined || handled(reports) < args.max) {
    let issues: Issue[];
    try {
      issues = await loop.issues();
    } catch (error) {
      return { reports, error };
    }
    const issue = issues.find((candidate) => !seen.has(candidate.number));
    if (issue === undefined) {
      break;
    }
    seen.add(issue.number);
    const report = await loop.process(issue);
    reports.push(report);
    if (loop.stop() || report.halt === true) {
      return { reports, stoppedAt: issue.number };
    }
    if (args.once && report.outcome !== 'skipped') {
      break;
    }
  }
  return { reports };
}

export async function watchIssues(
  args: Pick<Args, 'max' | 'once'>,
  watch: Watch,
): Promise<LoopResult> {
  const limit = args.once ? 1 : args.max;
  const reports: IssueReport[] = [];
  let step = 0;
  for (;;) {
    const pass = await runIssues(
      { once: false, max: limit === undefined ? undefined : limit - handled(reports) },
      watch,
    );
    reports.push(...pass.reports);
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
