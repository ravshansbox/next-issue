import type { AgentResult, Profile } from './agents.mts';
import { type Config, managedLabels } from './config.mts';
import { minutesToMs } from './durations.mts';
import { readTextIfPresent } from './files.mts';
import type { Repo } from './git.mts';
import type { Issue } from './github.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import { notesBlock } from './prompts.mts';
import { type IssueState, notesPath } from './state.mts';
import { paragraphs } from './text.mts';

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  reset: boolean;
  stopAfterRound: () => boolean;
  recorder: Recorder;
  ports: Ports;
};

export type Outcome = 'done' | 'needs-human' | 'skipped' | 'error' | 'stopped';

export type IssueReport = {
  issue: number;
  outcome: Outcome;
  reason?: string;
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
  mainBroken: boolean;
  repairing: boolean;
};

export type Finished = { done: true; report: IssueReport };

export type Gate = Finished | { done: false; fixed: boolean };

export type Round = Finished | { done: false };

export const ROUND_CONTINUE: Round = { done: false };

export const GATE_PASSED: Gate = { done: false, fixed: false };

export const GATE_FIXED: Gate = { done: false, fixed: true };

export function gateRound(gate: Gate): Round | undefined {
  if (gate.done) {
    return gate;
  }
  return gate.fixed ? ROUND_CONTINUE : undefined;
}

export async function runRole(
  job: Run,
  role: keyof Config['models'],
  prompt: string,
  profile: Profile,
): Promise<AgentResult> {
  const { config, ports, repo } = job.context;
  const path = notesPath(repo.root);
  const notes = await readTextIfPresent(path);
  const writable = role === 'implementer' || role === 'fixer';
  return ports.runAgent(job.log, {
    name: role,
    cwd: job.worktree,
    prompt: paragraphs([notesBlock(path, notes, writable), prompt]),
    profile,
    model: config.models[role],
    timeoutMs: minutesToMs(config.agentTimeoutMinutes),
  });
}

export function fallbackTitle(issue: Issue): string {
  return `fix: resolve issue #${issue.number}`;
}

export async function setStatus(context: Context, issue: number, label: string): Promise<void> {
  const { repo, config, ports } = context;
  await ports.setLabel(repo, 'issue', issue, label, managedLabels(config));
}
