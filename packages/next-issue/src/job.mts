import type { AgentResult, Profile } from './agents.mts';
import { type Config, managedLabels } from './config.mts';
import { minutesToMs } from './durations.mts';
import { readTextIfPresent } from './files.mts';
import type { Repo } from './git.mts';
import type { Issue } from './github.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import { notesBlock } from './prompts.mts';
import type { Slot } from './slots.mts';
import { type IssueState, notesPath } from './state.mts';
import { paragraphs } from './text.mts';

export type Context = {
  repo: Repo;
  config: Config;
  base: string;
  reset: boolean;
  stopAfterRound: () => boolean;
  halted: boolean;
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
  /** An error after the claim whose hand-over reached GitHub, so the label holds the issue until a person answers. */
  handedOver?: boolean;
  /** Skipped for an open blocker, so it may be claimed again once another issue of the run is done. */
  blocked?: boolean;
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
  /** The dispute branches that hold the edits a fixer left behind in this run. */
  asides: string[];
  /** The `concurrency` slot of the issue, freed while it lands; absent when nothing limits the agents. */
  slot?: Slot;
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

export async function withNotes(root: string, prompt: string, writable: boolean): Promise<string> {
  const path = notesPath(root);
  const notes = await readTextIfPresent(path);
  return paragraphs([notesBlock(path, notes, writable), prompt]);
}

export async function runRole(
  job: Run,
  role: keyof Config['models'],
  prompt: string,
  profile: Profile,
): Promise<AgentResult> {
  const { config, ports, repo } = job.context;
  const writable = role === 'implementer' || role === 'fixer';
  const request = {
    name: role,
    cwd: job.worktree,
    prompt: await withNotes(repo.root, prompt, writable),
    profile,
    model: config.models[role],
    timeoutMs: minutesToMs(config.agentTimeoutMinutes),
  };
  const took = (await job.slot?.take()) === true;
  try {
    return await ports.runAgent(job.log, request);
  } finally {
    if (took) {
      job.slot?.free();
    }
  }
}

export function fallbackTitle(issue: Issue): string {
  return `fix: resolve issue #${issue.number}`;
}

export async function setStatus(
  context: Context,
  issue: number,
  label: string,
  keep: string[] = [],
): Promise<void> {
  const { repo, config, ports } = context;
  const remove = managedLabels(config).filter((name) => !keep.includes(name));
  await ports.setLabel(repo, 'issue', issue, label, remove);
}
