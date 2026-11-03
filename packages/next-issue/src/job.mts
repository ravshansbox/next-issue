import { type Config, managedLabels } from './config.mts';
import type { Repo } from './git.mts';
import type { Issue } from './github.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import type { IssueState, ReviewRound } from './state.mts';
import { writeState } from './state.mts';

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  reset: boolean;
  merge: boolean;
  stopAfterRound: () => boolean;
  recorder: Recorder;
  ports: Ports;
};

export type Outcome = 'done' | 'needs-human' | 'skipped' | 'error' | 'stopped';

export type IssueReport = {
  issue: number;
  outcome: Outcome;
  reason?: string;
  pr?: number;
  ciFixes: number;
  reviewRounds: number;
  ms: number;
  halt?: boolean;
};

export type Run = {
  context: Context;
  issue: Issue;
  log: Recorder;
  state: IssueState;
  branch: string;
  worktree: string;
  comments: string[];
  reply: string[];
  started: number;
  noChecks: boolean;
  mainBroken: boolean;
};

export type Gate = { done: true; report: IssueReport } | { done: false; fixed: boolean };

export type Round = { done: true; report: IssueReport } | { done: false };

const worktreeQueues = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const result = (worktreeQueues.get(root) ?? Promise.resolve()).then(work);
  worktreeQueues.set(
    root,
    result.catch(() => undefined),
  );
  return result;
}

export async function openPr(job: Run): Promise<void> {
  const { context, issue, log, state, branch } = job;
  const { repo, config, ports } = context;
  const pr = await log.step('pull-request', { branch }, async () => {
    const existing = await ports.findPr(repo, branch);
    return (
      existing ??
      ports.createPr(
        repo,
        branch,
        context.base,
        state.title ?? `fix: resolve issue #${issue.number}`,
        `Closes #${issue.number}\n\nOpened by next-issue.`,
        config.draftPullRequest,
      )
    );
  });
  state.pr = pr;
  await writeState(repo, state);
  log.event('pull-request.ready', { pr }, 'quiet');
}

export async function setStatus(
  context: Context,
  issue: number,
  pr: number | undefined,
  label: string,
): Promise<void> {
  const managed = managedLabels(context.config);
  await context.ports.setLabel(context.repo, 'issue', issue, label, managed);
  if (pr !== undefined) {
    await context.ports.setLabel(context.repo, 'pr', pr, label, managed);
  }
}

export function history(rounds: ReviewRound[]): string[] {
  return rounds.map((round) => {
    const head = `Round ${round.round}:\n${round.findings}`;
    return round.dispute === undefined
      ? head
      : `${head}\nThe fixer disputed every finding of this round: ${round.dispute}`;
  });
}
