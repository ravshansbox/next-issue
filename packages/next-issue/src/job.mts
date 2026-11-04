import type { AgentResult, Profile } from './agents.mts';
import { type Config, managedLabels } from './config.mts';
import { minutesToMs } from './durations.mts';
import type { Repo } from './git.mts';
import type { Issue } from './github.mts';
import type { Recorder } from './observe.mts';
import type { Polling } from './poll.mts';
import type { Ports } from './ports.mts';
import { type IssueState, type ReviewRound, writeState } from './state.mts';

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

export type Finished = { done: true; report: IssueReport };

export type Gate = Finished | { done: false; fixed: boolean };

export type Round = Finished | { done: false };

export const GATE_PASSED: Gate = { done: false, fixed: false };

export const GATE_FIXED: Gate = { done: false, fixed: true };

export function gateRound(gate: Gate): Round | undefined {
  if (gate.done) {
    return gate;
  }
  return gate.fixed ? { done: false } : undefined;
}

export function runRole(
  job: Run,
  role: keyof Config['models'],
  prompt: string,
  profile: Profile,
): Promise<AgentResult> {
  const { config, ports } = job.context;
  return ports.runAgent(job.log, {
    name: role,
    cwd: job.worktree,
    prompt,
    profile,
    model: config.models[role],
    timeoutMs: minutesToMs(config.agentTimeoutMinutes),
  });
}

export function checkPolling(config: Config): Polling {
  return {
    intervalSeconds: config.checkIntervalSeconds,
    timeoutMs: minutesToMs(config.checkTimeoutMinutes),
  };
}

const worktreeQueues = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(root: string, work: () => Promise<T>): Promise<T> {
  const result = (worktreeQueues.get(root) ?? Promise.resolve()).then(work);
  worktreeQueues.set(
    root,
    result.catch(() => undefined),
  );
  return result;
}

export function fallbackTitle(issue: Issue): string {
  return `fix: resolve issue #${issue.number}`;
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
        state.title ?? fallbackTitle(issue),
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
  const { repo, config, ports } = context;
  const managed = managedLabels(config);
  await ports.setLabel(repo, 'issue', issue, label, managed);
  if (pr !== undefined) {
    await ports.setLabel(repo, 'pr', pr, label, managed);
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
