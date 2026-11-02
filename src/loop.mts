import type { Args } from "./args.mts";
import type { Issue } from "./github.mts";
import type { IssueReport } from "./pipeline.mts";

export type Loop = {
  issues: () => Promise<Issue[]>;
  process: (issue: Issue) => Promise<IssueReport>;
  stop: () => boolean;
};

export type LoopResult = { reports: IssueReport[]; stoppedAt?: number; error?: unknown };

export async function runIssues(args: Pick<Args, "max" | "once">, loop: Loop): Promise<LoopResult> {
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
    if (args.once && report.outcome !== "skipped") {
      break;
    }
  }
  return { reports };
}

export function exitCode(reports: IssueReport[]): number {
  return reports.some((report) => report.outcome === "needs-human" || report.outcome === "error") ? 1 : 0;
}

function handled(reports: IssueReport[]): number {
  return reports.filter((report) => report.outcome !== "skipped").length;
}
