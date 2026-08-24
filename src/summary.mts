import type { RoleTotals, Usage } from "./observe.mts";
import type { IssueReport, Outcome } from "./pipeline.mts";

export type RunSummary = {
  runId: string;
  logFile: string;
  roles: Record<string, RoleTotals>;
  counts: Record<string, number>;
  total: Usage;
  issues: IssueReport[];
};

const OUTCOMES: Outcome[] = ["done", "needs-human", "error", "skipped"];

export function formatSummary(summary: RunSummary): string {
  const tally = OUTCOMES.map(
    (outcome) => `${summary.issues.filter((report) => report.outcome === outcome).length} ${outcome}`,
  ).join(", ");
  const lines = [`run ${summary.runId}`, `issues ${summary.issues.length}: ${tally}`];
  for (const report of summary.issues) {
    lines.push(`  ${issueLine(report)}`);
  }
  const roles = Object.entries(summary.roles)
    .map(([role, totals]) => `${role} ${tokens(totals.total)} in ${totals.calls}`)
    .join(", ");
  lines.push(`tokens ${tokens(summary.total.total)}${roles.length > 0 ? ` (${roles})` : ""}`);
  lines.push(`log ${summary.logFile}`);
  return `${lines.join("\n")}\n`;
}

function issueLine(report: IssueReport): string {
  const parts = [`#${report.issue} ${report.outcome.padEnd(11)}`];
  if (report.pr !== undefined) {
    parts.push(`pr ${report.pr}`);
  }
  if (report.ciFixes > 0) {
    parts.push(`ci fixes ${report.ciFixes}`);
  }
  if (report.reviewRounds > 0) {
    parts.push(`reviews ${report.reviewRounds}`);
  }
  if (report.ms > 0) {
    parts.push(duration(report.ms));
  }
  if (report.reason !== undefined) {
    parts.push(`(${report.reason})`);
  }
  return parts.join("  ").trimEnd();
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function tokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(2)}M`;
}
