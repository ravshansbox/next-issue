import type { Args } from "./args.mts";
import type { Issue } from "./github.mts";
import type { IssueReport } from "./pipeline.mts";

export type Loop = {
  issues: Issue[];
  process: (issue: Issue) => Promise<IssueReport>;
  reset: (issue: number) => Promise<unknown>;
  stop: () => Promise<boolean>;
};

export type LoopResult = { reports: IssueReport[]; stoppedAt?: number };

export async function runIssues(args: Pick<Args, "max" | "once" | "reset">, loop: Loop): Promise<LoopResult> {
  await loop.stop();
  const reports: IssueReport[] = [];
  for (const issue of loop.issues) {
    if (args.max !== undefined && handled(reports) >= args.max) {
      break;
    }
    if (args.reset) {
      await loop.reset(issue.number);
    }
    const report = await loop.process(issue);
    reports.push(report);
    if (await loop.stop()) {
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
