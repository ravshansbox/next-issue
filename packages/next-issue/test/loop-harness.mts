import type { Issue } from '../src/github.mts';
import type { IssueReport, Outcome } from '../src/job.mts';

export function issue(number: number): Issue {
  return { number, title: 't', body: '', createdAt: '2026-01-01T00:00:00Z', labels: [] };
}

export function report(number: number, outcome: Outcome): IssueReport {
  return { issue: number, outcome, ciFixes: 0, reviewRounds: 0, ms: 0 };
}

export const ARGS = { once: false };
