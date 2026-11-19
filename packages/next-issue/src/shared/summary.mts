import type { IssueReport, Outcome } from './job.mts';
import type { RoleTotals, Usage } from './usage.mts';

export type RunSummary = {
  runId: string;
  logFile: string;
  roles: Record<string, RoleTotals>;
  counts: Record<string, number>;
  total: Usage;
  issues: IssueReport[];
};

export function count(reports: IssueReport[], outcome: Outcome): number {
  return reports.filter((report) => report.outcome === outcome).length;
}
