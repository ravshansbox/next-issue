import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AgentRequest, AgentResult } from '../src/agents.mts';
import type { CheckState } from '../src/check-poll.mts';
import type { WaitOptions } from '../src/checks.mts';
import { type Config, loadConfig } from '../src/config.mts';
import { HookError } from '../src/git-commit.mts';
import type { Issue } from '../src/github.mts';
import type { Context, IssueReport } from '../src/job.mts';
import { Recorder } from '../src/observe.mts';
import { processIssue } from '../src/pipeline.mts';
import type { Ports } from '../src/ports.mts';
import { applyEvent, startProgress } from '../src/progress.mts';
import type { Progress } from '../src/protocol.mts';
import { type IssueState, readState, writeState } from '../src/state.mts';
import type { Verdict } from '../src/verdict.mts';
import { tempDir } from './temp-dir.mts';
export const ISSUE: Issue = {
  number: 7,
  title: 'Add a flag',
  body: 'Please add it.',
  createdAt: '2026-01-01T00:00:00Z',
  labels: ['status:todo'],
};

export const APPROVE: Verdict = { summary: 'Good.', findings: [] };

export const SAVED: IssueState = {
  issue: 7,
  phase: 'review',
  branch: 'issue-7',
  pr: 101,
  ciFixes: 2,
  reviewRounds: 1,
  reviewLog: [{ round: 1, findings: '- old' }],
};

export function changes(...details: string[]): Verdict {
  return {
    summary: 'Please fix.',
    findings: details.map((detail) => ({ severity: 'blocking' as const, detail })),
  };
}

export function minor(...details: string[]): Verdict {
  return {
    summary: 'Taste.',
    findings: details.map((detail) => ({ severity: 'minor' as const, detail })),
  };
}

export function result(text: string): AgentResult {
  return {
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 1,
    toolCalls: 0,
    ms: 1,
    costUsd: 0,
  };
}

export type Plan = {
  config?: Partial<Config>;
  checks?: CheckState[];
  verdicts?: Verdict[];
  commits?: Array<boolean | string | Error>;
  diff?: string;
  setupCode?: number;
  setupTimedOut?: boolean;
  selfCommit?: boolean;
  fail?: keyof Ports;
  fixerText?: string | string[];
  implementerText?: string[];
  saved?: IssueState;
  reset?: boolean;
  reviewerWrites?: boolean;
  reviewerCommits?: boolean;
  fixerWrites?: boolean;
  detected?: string;
  issue?: Issue;
  baseUpdated?: boolean;
  blockers?: string[];
  merges?: Array<string[] | undefined>;
  alreadyMerged?: boolean;
  mergeResolved?: boolean;
  mergeHook?: string;
  pushRejects?: number;
  revertFails?: boolean;
  fixerThrows?: boolean;
  open?: Issue[];
  closed?: Issue[];
  unlisted?: Issue[];
  baseChecks?: CheckState[];
  pressDuring?: string;
  disputes?: string[];
  earlier?: string;
  thread?: Array<{ author: string; body: string }>;
  writers?: string[];
  issueComments?: Array<{ author: string; body: string }>;
  accessFails?: boolean;
};

export type Harness = {
  context: Context;
  profiles: Array<{ role: string; tools: string[] }>;
  labels: Array<{ kind: string; number: number; label: string }>;
  prompts: Array<{ role: string; prompt: string }>;
  messages: string[];
  comments: string[];
  issueNotes: Array<{ number: number; body: string }>;
  checkReads: number;
  discards: number;
  setups: string[];
  waits: WaitOptions[];
  checked: unknown[];
  pushes: number;
  forcedPushes: number;
  baseMerges: number;
  mergeAborts: string[];
  deleted: string[];
  landed: string[];
  reverts: Array<{ shas: string[]; message: string }>;
  closed: number[];
  baseWaits: string[];
  reopened: number[];
  resets: number;
  titles: string[];
  branches: string[];
  starts: boolean[];
  asides: Array<{ target: string; branch: string }>;
  threads: number[];
  events: Array<Record<string, unknown>>;
  head: () => string;
  run: () => Promise<IssueReport>;
  state: () => Promise<IssueState | undefined>;
};

export async function harness(t: TestContext, plan: Plan = {}): Promise<Harness> {
  t.mock.method(process.stderr, 'write', () => true);
  const root = await tempDir();
  const repo = { owner: 'acme', name: 'tool', root };
  const config = { ...(await loadConfig(root)), ...plan.config };
  const issue = plan.issue ?? ISSUE;
  if (plan.saved !== undefined) {
    await writeState(repo, plan.saved);
  }

  const checks = [...(plan.checks ?? ['pass'])];
  const baseChecks = [...(plan.baseChecks ?? [])];
  const verdicts = [...(plan.verdicts ?? [APPROVE])];
  const commits = [...(plan.commits ?? [])];
  const merges = [...(plan.merges ?? [])];
  let rejects = plan.pushRejects ?? 0;
  const fixerTexts = Array.isArray(plan.fixerText) ? [...plan.fixerText] : [];
  const implementerTexts = [...(plan.implementerText ?? [])];
  let head = 0;
  let pressed = false;
  const state: Harness = {
    context: undefined as unknown as Context,
    profiles: [],
    labels: [],
    prompts: [],
    messages: [],
    comments: [],
    issueNotes: [],
    checkReads: 0,
    discards: 0,
    setups: [],
    waits: [],
    checked: [],
    pushes: 0,
    forcedPushes: 0,
    baseMerges: 0,
    mergeAborts: [],
    deleted: [],
    landed: [],
    reverts: [],
    closed: [],
    baseWaits: [],
    reopened: [],
    resets: 0,
    titles: [],
    branches: [],
    starts: [],
    asides: [],
    threads: [],
    events: [],
    head: () => String(head),
    run: () => processIssue(state.context, issue),
    state: () => readState(repo, issue.number),
  };

  const ports: Ports = {
    canWrite: async (_repo, login) => {
      if (plan.accessFails === true) {
        throw new Error('gh: HTTP 500');
      }
      return (plan.writers ?? []).includes(login);
    },
    addWorktree: async (_repo, _issue, branch, _base, _remote, start) => {
      state.branches.push(branch);
      state.starts.push(start);
      return { path: join(root, 'worktree'), baseUpdated: plan.baseUpdated ?? true };
    },
    closeIssue: async (_repo, number) => {
      state.closed.push(number);
    },
    commentOnIssue: async (_repo, number, body) => {
      state.issueNotes.push({ number, body });
      state.comments.push(body);
    },
    commentOnPr: async (_repo, _pr, body) => {
      state.comments.push(body);
    },
    commitAll: async (_worktree, commitMessage) => {
      state.messages.push(commitMessage);
      const committed = commits.shift() ?? true;
      if (typeof committed === 'string') {
        throw new HookError(committed);
      }
      if (committed instanceof Error) {
        throw committed;
      }
      if (committed) {
        head += 1;
      }
      return committed;
    },
    createPr: async (_repo, _branch, _base, title) => {
      state.titles.push(title);
      return 101;
    },
    detectSetupCommand: async () => plan.detected,
    deleteBranch: async (_repo, branch) => {
      state.deleted.push(branch);
      return true;
    },
    diff: async () => plan.diff ?? 'the diff',
    discardChanges: async (_worktree, target) => {
      state.discards += 1;
      const moved = String(head) !== target;
      head = Number(target);
      return moved || plan.reviewerWrites === true;
    },
    disputeBranches: async () => plan.disputes ?? [],
    failedCheckLogs: async (_repo, pr) => {
      state.checked.push(pr);
      return 'the failed job logs';
    },
    failedBaseLogs: async () => 'the failed main logs',
    findPr: async () => undefined,
    findWorktree: async () => undefined,
    isDirty: async () => plan.fixerWrites === true,
    latestSubject: async () => plan.earlier,
    issueComments: async () => plan.issueComments ?? [],
    markPrReady: async () => true,
    mergePr: async () => true,
    mergeCommit: async () => undefined,
    openBlockers: async () => plan.blockers ?? [],
    openIssues: async () => [...(plan.open ?? [])],
    prConflicts: async () => false,
    startMerge: async () => {
      state.baseMerges += 1;
      return merges.shift();
    },
    squashOnto: async (_worktree, _base, _remote, commitMessage) => {
      state.messages.push(commitMessage);
      head += 1;
      return true;
    },
    pushToBase: async () => {
      if (rejects > 0) {
        rejects -= 1;
        return false;
      }
      state.landed.push(String(head));
      return true;
    },
    revertOnBase: async (_worktree, revert) => {
      state.reverts.push({ shas: revert.shas, message: revert.message });
      if (plan.revertFails === true) {
        return false;
      }
      head += 2;
      return true;
    },
    commitMerge: async (_worktree, _files, commitMessage) => {
      state.messages.push(commitMessage);
      if (plan.mergeHook !== undefined && state.messages.length === 2) {
        throw new HookError(plan.mergeHook);
      }
      if (plan.mergeResolved === false) {
        return false;
      }
      head += 1;
      return true;
    },
    abortMerge: async (_worktree, target) => {
      state.mergeAborts.push(target);
      head = Number(target);
    },
    prMerged: async () => plan.alreadyMerged === true,
    push: async (_worktree, _remote, _branch, force) => {
      state.pushes += 1;
      if (force === true) {
        state.forcedPushes += 1;
      }
    },
    removeWorktree: async () => true,
    reopenIssue: async (_repo, number) => {
      state.reopened.push(number);
    },
    resetToBase: async () => {
      state.resets += 1;
    },
    revision: async () => String(head),
    runAgent: async (_recorder, request: AgentRequest) => {
      state.prompts.push({ role: request.name, prompt: request.prompt });
      pressed ||= request.name === plan.pressDuring;
      state.profiles.push({ role: request.name, tools: request.profile.tools });
      if (request.name === 'reviewer') {
        if (plan.reviewerCommits === true) {
          head += 1;
        }
        const verdict = verdicts.shift();
        return result(
          verdict === undefined
            ? 'reviewed'
            : `reviewed\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
        );
      }
      if (plan.selfCommit === true) {
        head += 1;
      }
      if (request.name === 'fixer' && plan.fixerThrows === true) {
        throw new Error('the fixer timed out');
      }
      if (request.name === 'fixer' && plan.fixerText !== undefined) {
        const next = Array.isArray(plan.fixerText) ? fixerTexts.shift() : plan.fixerText;
        if (next !== undefined) {
          return result(next);
        }
      }
      const implementerText = request.name === 'implementer' ? implementerTexts.shift() : undefined;
      return result(implementerText ?? `commit: fix: work on #${issue.number}`);
    },
    runSetup: async (command) => {
      state.setups.push(command);
      return { code: plan.setupCode ?? 0, stderr: '', timedOut: plan.setupTimedOut };
    },
    setAside: async (_worktree, target, branch) => {
      state.asides.push({ target, branch });
      head = Number(target);
    },
    setLabel: async (_repo, kind, number, label) => {
      state.labels.push({ kind, number, label });
    },
    threadComments: async (_repo, number) => {
      state.threads.push(number);
      return plan.thread ?? [];
    },
    viewIssue: async (_repo, number) => {
      const closed = (plan.closed ?? []).find((entry) => entry.number === number);
      return closed === undefined
        ? { ...(plan.unlisted ?? []).find((entry) => entry.number === number)!, open: true }
        : { ...closed, open: false };
    },
    waitForBaseChecks: async (_repo, sha) => {
      state.baseWaits.push(sha);
      return baseChecks.shift() ?? 'pass';
    },
    waitForChecks: async (_repo, pr, options) => {
      state.checked.push(pr);
      state.waits.push(options);
      const next = checks[Math.min(state.checkReads, checks.length - 1)]!;
      state.checkReads += 1;
      return next;
    },
  };
  if (plan.fail !== undefined) {
    (ports[plan.fail] as unknown) = async () => {
      throw new Error('the port broke');
    };
  }

  const recorder = await Recorder.create(root, 'quiet', (record) => state.events.push(record));
  t.after(() => recorder.close());
  state.context = {
    repo,
    config,
    base: 'main',
    reset: plan.reset === true,
    stopAfterRound: () => pressed,
    recorder,
    ports,
  };
  return state;
}

export function stages(target: Harness): string[] {
  const seen: string[] = [];
  target.events.reduce<Progress>((progress, record) => {
    const next = applyEvent(progress, record);
    const stage = next.issues[0]?.stage;
    if (stage !== undefined && stage !== seen.at(-1)) {
      seen.push(stage);
    }
    return next;
  }, startProgress());
  return seen;
}

export function roles(target: Harness): string[] {
  return target.prompts.map((entry) => entry.role);
}
