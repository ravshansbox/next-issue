import type { Args } from './args.mts';
import type { Issue } from './github.mts';
import type { IssueReport } from './job.mts';

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue, claimed?: () => void) => Promise<IssueReport>;
  stop: () => boolean;
  concurrency?: number;
};

export type LoopResult = {
  reports: IssueReport[];
  stoppedAt?: number;
  error?: unknown;
  crash?: { failure: unknown };
};

type Settled = { issue: number; report?: IssueReport; failure?: unknown };

/** Issues that may be claimed again in the pass once their labels differ from those of the first fetch after their attempt. */
type Tried = { ended: Set<number>; labels: Map<number, string | undefined> };

export async function runIssues(
  args: Pick<Args, 'max'>,
  loop: Loop,
  seen = new Set<number>(),
): Promise<LoopResult> {
  const limit = args.max;
  const concurrency = loop.concurrency ?? 1;
  const reports: IssueReport[] = [];
  const running = new Map<number, Promise<Settled>>();
  let stoppedAt: number | undefined;
  let error: unknown;
  let crash: { failure: unknown } | undefined;
  let claiming = true;
  const tried: Tried = { ended: new Set(), labels: new Map() };
  const room = (): boolean =>
    running.size < concurrency && (limit === undefined || handled(reports) + running.size < limit);
  for (;;) {
    if (claiming && room()) {
      try {
        claiming = await claimIssues(loop, seen, tried, running, room);
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
    if (retryable(report)) {
      tried.ended.add(issue);
    }
    if (claiming && (loop.stop() || report.halt === true)) {
      stoppedAt = issue;
      claiming = false;
    }
  }
  return loopResult(reports, stoppedAt, error, crash);
}

function loopResult(
  reports: IssueReport[],
  stoppedAt: number | undefined,
  error: unknown,
  crash: { failure: unknown } | undefined,
): LoopResult {
  return {
    reports,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(error === undefined ? {} : { error }),
    ...(crash === undefined ? {} : { crash }),
  };
}

async function claimIssues(
  loop: Loop,
  seen: Set<number>,
  tried: Tried,
  running: Map<number, Promise<Settled>>,
  room: () => boolean,
): Promise<boolean> {
  if (loop.stop()) {
    return false;
  }
  const issues = await loop.issues();
  if (loop.stop()) {
    return false;
  }
  readmitChanged(issues, seen, tried);
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
  return true;
}

function retryable(report: IssueReport): boolean {
  return report.outcome !== 'done' && (report.outcome !== 'error' || report.handedOver === true);
}

function readmitChanged(issues: Issue[], seen: Set<number>, tried: Tried): void {
  const listed = new Map(issues.map((issue) => [issue.number, labelKey(issue)]));
  for (const [number, labels] of tried.labels) {
    if (listed.has(number) && listed.get(number) !== labels) {
      tried.labels.delete(number);
      seen.delete(number);
    }
  }
  for (const number of tried.ended) {
    tried.labels.set(number, listed.get(number));
  }
  tried.ended.clear();
}

function labelKey(issue: Issue): string {
  return [...issue.labels].sort().join('\n');
}

export function exitCode(reports: IssueReport[]): number {
  return reports.some((report) => report.outcome === 'needs-human' || report.outcome === 'error')
    ? 1
    : 0;
}

export function handled(reports: IssueReport[]): number {
  return reports.filter((report) => report.outcome !== 'skipped').length;
}
