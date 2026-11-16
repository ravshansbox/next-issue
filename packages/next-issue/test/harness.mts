import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AgentRequest, AgentResult } from '../src/agents.mts';
import type { CheckState } from '../src/check-poll.mts';
import {
  refuseWhenStopped,
  runChildren,
  stopRunChildren,
  withRunChildren,
} from '../src/children.mts';
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
import { fullDisk } from './full-disk.mts';
import { tempDir } from './temp-dir.mts';
export const ISSUE: Issue = {
  number: 7,
  title: 'Add a flag',
  body: 'Please add it.',
  createdAt: '2026-01-01T00:00:00Z',
  labels: ['status:todo'],
};

const MAINTAINER = 'maintainer';

export const APPROVE: Verdict = { summary: 'Good.', findings: [] };

export const SAVED: IssueState = {
  issue: 7,
  phase: 'review',
  branch: 'issue-7',
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
  };
}

export const PUSH_REJECTED = '! [rejected] HEAD -> main (fetch first)';

export type Plan = {
  config?: Partial<Config>;
  verdicts?: Verdict[];
  commits?: Array<boolean | string | Error>;
  diff?: string;
  baseLogs?: string;
  changedFiles?: string[];
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
  /** The issue as GitHub holds it when the harness reads it again during the run. */
  fresh?: Issue;
  baseUpdated?: boolean;
  branchUpdated?: boolean;
  landedBaseUpdated?: boolean;
  landedFetchFails?: boolean;
  blockers?: string[];
  canonicalSlug?: string;
  merges?: Array<string[] | undefined>;
  mergeResolved?: boolean;
  mergeHook?: string;
  pushRejects?: number;
  /** The error of git for a push that the remote refuses while the base stays put. */
  pushRefused?: string;
  pushLandsAndFails?: boolean;
  pushLandsAndStops?: boolean;
  baseFetchFails?: boolean;
  baseMoved?: boolean;
  revertFails?: boolean;
  revertLandsAndStops?: boolean;
  fixerThrows?: boolean;
  open?: Issue[];
  closed?: Issue[];
  unlisted?: Issue[];
  baseChecks?: CheckState[];
  rerunChecks?: CheckState[];
  rerunFails?: boolean;
  /** Commits whose failed workflow runs were already rerun, as GitHub shows by their attempts. */
  rerunDone?: string[];
  pressDuring?: string;
  stopNowDuring?: string;
  /** The agent (or `rerun`) that never settles, as when the process is killed while it runs. */
  hangDuring?: string;
  stopNowDuringSetup?: boolean;
  /** The exit codes of the local check commands in turn; a missing code passes, `timeout` does not finish. */
  checkCodes?: Array<number | 'timeout'>;
  stopNowDuringCheck?: boolean;
  stopNowOnLabel?: string;
  disputes?: string[];
  earlier?: string;
  thread?: Array<{ author: string; body: string; url?: string; createdAt?: string }>;
  writers?: string[];
  /** The last people to change the issue body and title; by default a person with write access. */
  editors?: { body: string; title: string };
  /** The title and body GitHub holds when the worker checks the editors; by default the listed ones. */
  current?: { title: string; body: string };
  issueComments?: Array<{ author: string; body: string }>;
  accessFails?: boolean;
  hunterText?: string;
  root?: string;
  onEvent?: (record: Record<string, unknown>) => void;
  /** Every write to the run log fails with `ENOSPC`, as on a full disk. */
  runLogFails?: boolean;
};

export type Harness = {
  context: Context;
  profiles: Array<{ role: string; tools: string[] }>;
  labels: Array<{ kind: string; number: number; label: string }>;
  removable: string[][];
  prompts: Array<{ role: string; prompt: string }>;
  messages: string[];
  comments: string[];
  issueNotes: Array<{ number: number; body: string }>;
  /** Each body the harness wrote to an issue. */
  bodies: Array<{ number: number; body: string }>;
  discards: number;
  setups: string[];
  /** Each local check command run, with the head it ran on. */
  checks: Array<{ command: string; head: string }>;
  pushes: number;
  forcedPushes: number;
  baseMerges: number;
  mergeAborts: string[];
  deleted: string[];
  landed: string[];
  localBase: string | undefined;
  reverts: Array<{ shas: string[]; message: string }>;
  reapplies: string[];
  closed: number[];
  baseWaits: string[];
  reruns: string[];
  reopened: number[];
  resets: number;
  branches: string[];
  starts: boolean[];
  asides: Array<{ target: string; branch: string }>;
  /** Edits of a fixer committed by `saveEdits`. */
  saves: number;
  threads: number[];
  events: Array<Record<string, unknown>>;
  hunts: string[];
  head: () => string;
  stopNow: () => void;
  /** Settles when the step named by `hangDuring` starts. */
  hung: Promise<void>;
  run: (claimed?: () => void) => Promise<IssueReport>;
  state: () => Promise<IssueState | undefined>;
};

export async function harness(t: TestContext, plan: Plan = {}): Promise<Harness> {
  t.mock.method(process.stderr, 'write', () => true);
  const root = plan.root ?? (await tempDir());
  const repo = { owner: 'acme', name: 'tool', root };
  const config = { ...(await loadConfig(root)), ...plan.config };
  const issue = plan.issue ?? ISSUE;
  if (plan.saved !== undefined) {
    await writeState(repo, plan.saved);
  }

  const baseChecks = [...(plan.baseChecks ?? [])];
  const rerunChecks = [...(plan.rerunChecks ?? [])];
  let rerun = false;
  const rerunDone = new Set(plan.rerunDone ?? []);
  const verdicts = [...(plan.verdicts ?? [APPROVE])];
  const commits = [...(plan.commits ?? [])];
  const merges = [...(plan.merges ?? [])];
  const checkCodes = [...(plan.checkCodes ?? [])];
  let rejects = plan.pushRejects ?? 0;
  const fixerTexts = Array.isArray(plan.fixerText) ? [...plan.fixerText] : [];
  const implementerTexts = [...(plan.implementerText ?? [])];
  let head = 0;
  let remoteBase: string | undefined;
  let pressed = false;
  let removed = false;
  const children = runChildren();
  let hang = (): void => undefined;
  const hung = new Promise<void>((resolve) => {
    hang = resolve;
  });
  const hangIf = async (name: string): Promise<void> => {
    if (name === plan.hangDuring) {
      hang();
      await new Promise(() => undefined);
    }
  };
  const state: Harness = {
    context: undefined as unknown as Context,
    profiles: [],
    labels: [],
    removable: [],
    prompts: [],
    messages: [],
    comments: [],
    issueNotes: [],
    bodies: [],
    discards: 0,
    setups: [],
    checks: [],
    pushes: 0,
    forcedPushes: 0,
    baseMerges: 0,
    mergeAborts: [],
    deleted: [],
    landed: [],
    localBase: undefined,
    reverts: [],
    reapplies: [],
    closed: [],
    baseWaits: [],
    reruns: [],
    reopened: [],
    resets: 0,
    branches: [],
    starts: [],
    asides: [],
    saves: 0,
    threads: [],
    events: [],
    hunts: [],
    head: () => String(head),
    stopNow: () => stopRunChildren(children),
    hung,
    run: (claimed) => withRunChildren(children, () => processIssue(state.context, issue, claimed)),
    state: () => readState(repo, issue.number),
  };

  const ports: Ports = {
    canWrite: async (_repo, login) => {
      if (plan.accessFails === true) {
        throw new Error('gh: HTTP 500');
      }
      return login === MAINTAINER || (plan.writers ?? []).includes(login);
    },
    addWorktree: async (_repo, _issue, branch, _base, _remote, start) => {
      state.branches.push(branch);
      state.starts.push(start);
      return {
        path: join(root, 'worktree'),
        baseUpdated: plan.baseUpdated ?? true,
        branchUpdated: plan.branchUpdated ?? true,
      };
    },
    fastForwardBase: async () => {
      if (plan.landedFetchFails === true) {
        throw new Error('git fetch: could not resolve host');
      }
      if (plan.landedBaseUpdated === false) {
        return false;
      }
      state.localBase = remoteBase;
      return true;
    },
    closeIssue: async (_repo, number) => {
      state.closed.push(number);
    },
    commentOnIssue: async (_repo, number, body) => {
      if (body.length > 65536) {
        throw new Error('gh: HTTP 422: body is too long (maximum is 65536 characters)');
      }
      state.issueNotes.push({ number, body });
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
    detectSetupCommand: async () => plan.detected,
    deleteBranch: async (_repo, branch) => {
      state.deleted.push(branch);
      return true;
    },
    diff: async () => plan.diff ?? 'the diff',
    editIssueBody: async (_repo, number, body) => {
      state.bodies.push({ number, body });
    },
    discardChanges: async (_worktree, target) => {
      state.discards += 1;
      const moved = String(head) !== target;
      head = Number(target);
      return moved || plan.reviewerWrites === true;
    },
    disputeBranches: async () => plan.disputes ?? [],
    ensureLabel: async () => undefined,
    failedCiLogs: async () => {
      await hangIf('logs');
      return plan.baseLogs ?? 'the failed main logs';
    },
    changedFiles: async () => plan.changedFiles ?? [],
    findWorktree: async () => (removed ? undefined : join(root, 'worktree')),
    huntWorktree: async (_repo, base) => {
      state.hunts.push(base);
      return join(root, 'hunt');
    },
    isDirty: async () => plan.fixerWrites === true,
    latestSubject: async () => plan.earlier,
    issueComments: async () => plan.issueComments ?? [],
    openBlockers: async () => plan.blockers ?? [],
    repositorySlug: async (repo) => plan.canonicalSlug ?? `${repo.owner}/${repo.name}`,
    openIssues: async () => [...(plan.open ?? [])],
    startMerge: async (_worktree, base, remote) => {
      state.baseMerges += 1;
      return { target: `${remote}/${base}`, files: merges.shift(), unmarked: [] };
    },
    squashOnto: async (_worktree, _target, commitMessage) => {
      state.messages.push(commitMessage);
      head += 1;
      return true;
    },
    pushToBase: async () => {
      if (plan.pushRefused !== undefined) {
        return { pushed: false, error: plan.pushRefused };
      }
      if (rejects > 0) {
        rejects -= 1;
        return { pushed: false, error: PUSH_REJECTED };
      }
      state.landed.push(String(head));
      remoteBase = String(head);
      if (plan.pushLandsAndStops === true) {
        stopRunChildren(children);
        return { pushed: false, error: PUSH_REJECTED };
      }
      return plan.pushLandsAndFails === true
        ? { pushed: false, error: PUSH_REJECTED }
        : { pushed: true };
    },
    baseMoved: async () => plan.pushRefused === undefined,
    isOnBase: async (_worktree, _base, _remote, sha) => {
      refuseWhenStopped();
      if (plan.baseFetchFails === true) {
        throw new Error('fetch failed');
      }
      return state.landed.includes(sha) || plan.baseMoved === true;
    },
    reapplyRevert: async () => false,
    revertOnBase: async (_worktree, revert) => {
      state.reverts.push({ shas: revert.shas, message: revert.message });
      state.reapplies.push(revert.reapply);
      if (plan.revertFails === true) {
        return false;
      }
      if (plan.revertLandsAndStops === true) {
        await revert.pushing(String(head + 1));
        state.landed.push(String(head + 1));
        stopRunChildren(children);
        refuseWhenStopped();
      }
      remoteBase = String(head + 1);
      head += 2;
      return true;
    },
    commitMerge: async (_worktree, _merge, commitMessage) => {
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
    abortMerge: async (worktree, target) => {
      if (removed) {
        throw new Error(`spawn git ENOENT: ${worktree}`);
      }
      state.mergeAborts.push(target);
      head = Number(target);
    },
    push: async (_worktree, _remote, _branch, force) => {
      state.pushes += 1;
      if (force === true) {
        state.forcedPushes += 1;
      }
    },
    removeWorktree: async () => {
      removed = true;
      return true;
    },
    reopenIssue: async (_repo, number) => {
      state.reopened.push(number);
    },
    resetToBase: async () => {
      state.resets += 1;
    },
    rerunFailedCi: async (_repo, sha, _branch, started = () => undefined) => {
      if (rerunDone.has(sha)) {
        return [];
      }
      state.reruns.push(sha);
      await hangIf('rerun');
      if (plan.rerunFails === true) {
        throw new Error('run 41 cannot be rerun');
      }
      rerunDone.add(sha);
      started({ id: 41, attempt: 1 });
      rerun = true;
      return ['41'];
    },
    revision: async () => String(head),
    isLanded: async () => plan.baseMoved === true,
    runAgent: async (_recorder, request: AgentRequest) => {
      state.prompts.push({ role: request.name, prompt: request.prompt });
      pressed ||= request.name === plan.pressDuring;
      if (request.name === plan.stopNowDuring) {
        stopRunChildren(children);
        throw new Error('The run stopped.');
      }
      await hangIf(request.name);
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
      if (request.name === 'hunter') {
        return result(plan.hunterText ?? 'Nothing found.\nissue: none');
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
      if (plan.stopNowDuringSetup === true) {
        stopRunChildren(children);
        return { code: 130, stderr: '', timedOut: false };
      }
      return { code: plan.setupCode ?? 0, stderr: '', timedOut: plan.setupTimedOut };
    },
    runCheck: async (command) => {
      state.checks.push({ command, head: String(head) });
      if (plan.stopNowDuringCheck === true) {
        stopRunChildren(children);
        return { code: 143, output: '', timedOut: false };
      }
      const code = checkCodes.shift() ?? 0;
      if (code === 'timeout') {
        return { code: 143, output: `${command} hung`, timedOut: true };
      }
      return { code, output: code === 0 ? 'ok' : `${command} broke`, timedOut: false };
    },
    saveEdits: async () => {
      if (plan.fixerWrites !== true) {
        return false;
      }
      state.saves += 1;
      head += state.saves;
      return true;
    },
    saveSetupOutput: async () => {},
    setAside: async (_worktree, target, branch) => {
      state.asides.push({ target, branch });
      head = Number(target);
    },
    setLabel: async (_repo, kind, number, label, remove) => {
      refuseWhenStopped();
      state.labels.push({ kind, number, label });
      state.removable.push(remove);
      if (label === plan.stopNowOnLabel) {
        stopRunChildren(children);
        refuseWhenStopped();
      }
    },
    issueEditors: async () => ({
      ...(plan.current ?? { title: issue.title, body: issue.body }),
      editors: plan.editors ?? { body: MAINTAINER, title: MAINTAINER },
    }),
    threadComments: async (_repo, number) => {
      state.threads.push(number);
      return plan.thread ?? [];
    },
    viewIssue: async (_repo, number) => {
      if (plan.fresh?.number === number) {
        return { ...plan.fresh, open: true };
      }
      const closed = (plan.closed ?? []).find((entry) => entry.number === number);
      return closed === undefined
        ? { ...(plan.unlisted ?? []).find((entry) => entry.number === number)!, open: true }
        : { ...closed, open: false };
    },
    waitForCiChecks: async (_repo, sha) => {
      if (rerun) {
        rerun = false;
        return rerunChecks.shift() ?? 'fail';
      }
      state.baseWaits.push(sha);
      return baseChecks.shift() ?? 'pass';
    },
  };
  if (plan.fail !== undefined) {
    (ports[plan.fail] as unknown) = async () => {
      throw new Error('the port broke');
    };
  }

  const recorder = await Recorder.create(
    root,
    'quiet',
    (record) => {
      state.events.push(record);
      plan.onEvent?.(record);
    },
    plan.runLogFails === true ? fullDisk : undefined,
  );
  t.after(() => recorder.close());
  state.context = {
    repo,
    config,
    base: 'main',
    reset: plan.reset === true,
    stopAfterRound: () => pressed,
    halted: false,
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
