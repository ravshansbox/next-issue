import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import type { IssueReport } from './job.mts';

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue, claimed?: () => void) => Promise<IssueReport>;
  stop: () => boolean;
  concurrency?: number;
};

export type LoopResult = { reports: IssueReport[]; stoppedAt?: number; error?: unknown };

type Settled = { issue: number; report?: IssueReport; failure?: unknown };

export async function runIssues(
  args: Pick<Args, 'max' | 'once'>,
  loop: Loop,
  seen = new Set<number>(),
): Promise<LoopResult> {
  const limit = args.once ? Math.min(1, args.max ?? 1) : args.max;
  const concurrency = loop.concurrency ?? 1;
  const reports: IssueReport[] = [];
  const running = new Map<number, Promise<Settled>>();
  let stoppedAt: number | undefined;
  let error: unknown;
  let crash: { failure: unknown } | undefined;
  let claiming = true;
  const room = (): boolean =>
    running.size < concurrency && (limit === undefined || handled(reports) + running.size < limit);
  for (;;) {
    if (claiming && room()) {
      try {
        await claimIssues(loop, seen, running, room);
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
  return loopResult(reports, stoppedAt, error);
}

function loopResult(
  reports: IssueReport[],
  stoppedAt: number | undefined,
  error: unknown,
): LoopResult {
  return {
    reports,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

async function claimIssues(
  loop: Loop,
  seen: Set<number>,
  running: Map<number, Promise<Settled>>,
  room: () => boolean,
): Promise<void> {
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
}

export function exitCode(reports: IssueReport[]): number {
  return reports.some((report) => report.outcome === 'needs-human' || report.outcome === 'error')
    ? 1
    : 0;
}

export function handled(reports: IssueReport[]): number {
  return reports.filter((report) => report.outcome !== 'skipped').length;
}
