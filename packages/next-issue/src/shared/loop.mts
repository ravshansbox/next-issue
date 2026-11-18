import type { Issue } from './github.mts';
import type { IssueReport } from './job.mts';
import { type Slot, Slots } from './slots.mts';

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue, claimed?: () => void, slot?: Slot) => Promise<IssueReport>;
  stop: () => boolean;
  concurrency?: number;
  // Aborts when a client asks for new issues; a pass then reads the open issues again, even with every slot taken.
  refreshed?: () => AbortSignal;
};

export type LoopResult = {
  reports: IssueReport[];
  stoppedAt?: number;
  error?: unknown;
  crash?: { failure: unknown };
  refreshed?: AbortSignal;
};

type Settled = { issue: number; slot: Slot; report?: IssueReport; failure?: unknown };

/**
 * Issues that may be claimed again in the pass once their labels differ from those of the first fetch after their
 * attempt, and issues skipped for an open blocker, claimed again once another issue is done.
 */
type Tried = { ended: Set<number>; labels: Map<number, string | undefined>; blocked: Set<number> };

export async function runIssues(loop: Loop, seen = new Set<number>()): Promise<LoopResult> {
  const slots = new Slots(loop.concurrency ?? 1);
  const reports: IssueReport[] = [];
  const running = new Map<number, Promise<Settled>>();
  let stoppedAt: number | undefined;
  let error: unknown;
  let crash: { failure: unknown } | undefined;
  let claiming = true;
  let stopped = false;
  let unclaimed = true;
  let recount = false;
  const ended = new AbortController();
  let refresh = refreshes(loop, ended.signal);
  const tried: Tried = { ended: new Set(), labels: new Map(), blocked: new Set() };
  try {
    for (;;) {
      if (stopped && !loop.stop()) {
        stopped = false;
        stoppedAt = undefined;
        claiming = true;
      }
      if (claiming && (recount || (unclaimed && slots.open()))) {
        recount = false;
        refresh = refreshes(loop, ended.signal, refresh);
        try {
          ({ claiming, unclaimed } = await claimIssues(loop, seen, tried, { running, slots }));
        } catch (failure) {
          error = failure;
          claiming = false;
        }
      }
      if (running.size === 0) {
        break;
      }
      const settled = await Promise.race([...running.values(), slots.freed(), refresh.asked]);
      if (settled === 'refresh') {
        recount = true;
        refresh = refreshes(loop, ended.signal, refresh);
        continue;
      }
      if (settled === undefined) {
        continue;
      }
      const { issue, slot, report, failure } = settled;
      running.delete(issue);
      slot.free();
      unclaimed = true;
      recount = true;
      if (report === undefined) {
        crash ??= { failure };
        claiming = false;
        stopped = false;
        continue;
      }
      reports.push(report);
      if (retryable(report)) {
        tried.ended.add(issue);
      }
      if (report.blocked === true) {
        tried.blocked.add(issue);
      }
      if (report.outcome === 'done') {
        readmitBlocked(seen, tried);
      }
      if (claiming && (loop.stop() || report.halt === true)) {
        stoppedAt = issue;
        claiming = false;
        stopped = true;
      }
      if (report.halt === true) {
        stopped = false;
      }
      if (report.outcome === 'done' && !claiming) {
        await loop.issues().catch(() => undefined);
      }
    }
  } finally {
    ended.abort();
  }
  return { ...loopResult(reports, stoppedAt, error, crash), ...refreshedOf(refresh) };
}

function refreshedOf(refresh: Refresh): { refreshed?: AbortSignal } {
  return refresh.signal === undefined ? {} : { refreshed: refresh.signal };
}

type Refresh = { signal?: AbortSignal; asked: Promise<'refresh'> };

function refreshes(loop: Loop, ended: AbortSignal, previous?: Refresh): Refresh {
  const signal = loop.refreshed?.();
  if (previous !== undefined && previous.signal === signal) {
    return previous;
  }
  return {
    signal,
    asked: new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve('refresh');
      } else {
        signal?.addEventListener('abort', () => resolve('refresh'), { once: true, signal: ended });
      }
    }),
  };
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
  pool: { running: Map<number, Promise<Settled>>; slots: Slots },
): Promise<{ claiming: boolean; unclaimed: boolean }> {
  if (loop.stop()) {
    return { claiming: false, unclaimed: false };
  }
  const issues = await loop.issues();
  if (loop.stop()) {
    return { claiming: false, unclaimed: false };
  }
  readmitChanged(issues, seen, tried);
  for (const issue of issues.filter((candidate) => !seen.has(candidate.number))) {
    if (!pool.slots.open()) {
      return { claiming: true, unclaimed: true };
    }
    seen.add(issue.number);
    const slot = pool.slots.claim();
    pool.running.set(
      issue.number,
      loop.process(issue, undefined, slot).then(
        (report) => ({ issue: issue.number, slot, report }),
        (failure: unknown) => ({ issue: issue.number, slot, failure }),
      ),
    );
  }
  return { claiming: true, unclaimed: false };
}

function retryable(report: IssueReport): boolean {
  return report.outcome !== 'done' && (report.outcome !== 'error' || report.handedOver === true);
}

function readmitChanged(issues: Issue[], seen: Set<number>, tried: Tried): void {
  const listed = new Map(issues.map((issue) => [issue.number, labelKey(issue)]));
  for (const [number, labels] of tried.labels) {
    if (listed.has(number) && listed.get(number) !== labels) {
      tried.labels.delete(number);
      tried.blocked.delete(number);
      seen.delete(number);
    }
  }
  for (const number of tried.ended) {
    tried.labels.set(number, listed.get(number));
  }
  tried.ended.clear();
}

function readmitBlocked(seen: Set<number>, tried: Tried): void {
  for (const number of tried.blocked) {
    tried.ended.delete(number);
    tried.labels.delete(number);
    seen.delete(number);
  }
  tried.blocked.clear();
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
