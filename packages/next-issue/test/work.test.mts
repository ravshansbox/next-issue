import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentRequest, AgentResult } from '../src/agents.mts';
import { type Config, loadConfig } from '../src/config.mts';
import type { CheckState, Issue, WaitOptions } from '../src/github.mts';
import { HookError } from '../src/git.mts';
import { Recorder } from '../src/observe.mts';
import {
  type Context,
  type IssueReport,
  pendingIssues,
  type Ports,
  processIssue,
} from '../src/pipeline.mts';
import { type IssueState, readState, STATE_DIR, writeState } from '../src/state.mts';
import type { Verdict } from '../src/verdict.mts';

const ISSUE: Issue = {
  number: 7,
  title: 'Add a flag',
  body: 'Please add it.',
  createdAt: '2026-01-01T00:00:00Z',
  labels: ['status:todo'],
};

const APPROVE: Verdict = { summary: 'Good.', findings: [] };

function changes(...details: string[]): Verdict {
  return {
    summary: 'Please fix.',
    findings: details.map((detail) => ({ severity: 'blocking' as const, detail })),
  };
}

function minor(...details: string[]): Verdict {
  return {
    summary: 'Taste.',
    findings: details.map((detail) => ({ severity: 'minor' as const, detail })),
  };
}

function result(text: string): AgentResult {
  return {
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 1,
    toolCalls: 0,
    ms: 1,
    costUsd: 0,
  };
}

type Plan = {
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
  merge?: boolean;
  mergeFails?: boolean;
  mergeQueued?: boolean;
  alreadyMerged?: boolean;
  conflicts?: boolean;
  open?: Issue[];
  closed?: Issue[];
  unlisted?: Issue[];
  baseChecks?: CheckState[];
  pressDuring?: string;
  disputes?: string[];
  earlier?: string;
};

type Harness = {
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
  ready: number[];
  deleted: string[];
  merged: number[];
  baseWaits: string[];
  reopened: number[];
  resets: number;
  titles: string[];
  branches: string[];
  starts: boolean[];
  asides: Array<{ target: string; branch: string }>;
  head: () => string;
  run: () => Promise<IssueReport>;
  state: () => Promise<IssueState | undefined>;
};

async function harness(t: TestContext, plan: Plan = {}): Promise<Harness> {
  t.mock.method(process.stderr, 'write', () => true);
  const root = await mkdtemp(join(tmpdir(), 'next-issue-'));
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
    ready: [],
    deleted: [],
    merged: [],
    baseWaits: [],
    reopened: [],
    resets: 0,
    titles: [],
    branches: [],
    starts: [],
    asides: [],
    head: () => String(head),
    run: () => processIssue(state.context, issue),
    state: () => readState(repo, issue.number),
  };

  const ports: Ports = {
    addWorktree: async (_repo, _issue, branch, _base, _remote, start) => {
      state.branches.push(branch);
      state.starts.push(start);
      return { path: join(root, 'worktree'), baseUpdated: plan.baseUpdated ?? true };
    },
    commentOnIssue: async (_repo, number, body) => {
      state.issueNotes.push({ number, body });
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
      return 101 + state.merged.length;
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
    issueComments: async () => [],
    markPrReady: async (_repo, pr) => {
      state.ready.push(pr);
      return true;
    },
    mergePr: async (_repo, pr) => {
      state.merged.push(pr);
      return plan.mergeFails !== true;
    },
    mergeCommit: async (_repo, pr) => (plan.mergeQueued === true ? undefined : `merge-of-${pr}`),
    openBlockers: async () => plan.blockers ?? [],
    openIssues: async () => [...(plan.open ?? [])],
    prConflicts: async () => plan.conflicts === true,
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

  const recorder = await Recorder.create(root, 'quiet');
  t.after(() => recorder.close());
  state.context = {
    repo,
    config,
    base: 'main',
    reset: plan.reset === true,
    merge: plan.merge === true,
    stopAfterRound: () => pressed,
    recorder,
    ports,
  };
  return state;
}

function roles(target: Harness): string[] {
  return target.prompts.map((entry) => entry.role);
}

test('a clean run implements, reviews and finishes', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reason, undefined);
  assert.equal(report.pr, 101);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, [101]);
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ['7']);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a user who passes --merge gets the approved pull request merged', async (t) => {
  const target = await harness(t, { merge: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.merged, [101]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user who leaves out --merge keeps the merge', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.merged, []);
});

test('a user whose merge fails gets the issue handed over', async (t) => {
  const target = await harness(t, { merge: true, mergeFails: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge failed');
  assert.match(target.comments.at(-1)!, /needs help: The merge of the pull request failed/);
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal((await target.state())?.handedOver, true);
});

test('a user whose queued merge does not finish in time gets the issue handed over instead of done', async (t) => {
  const target = await harness(t, { merge: true, mergeQueued: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'not merged');
  assert.deepEqual(target.baseWaits, []);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The pull request did not merge in time, or it closed without a merge/,
  );
});

test('a user who passes --merge gets no merge while the build fails after the approval', async (t) => {
  const target = await harness(t, {
    merge: true,
    config: { maxCiFixes: 0 },
    checks: ['pass', 'fail'],
  });
  await target.run();
  assert.deepEqual(target.merged, []);
});

test('a user who passes --merge gets the issue done only after the checks on main pass', async (t) => {
  const target = await harness(t, { merge: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
  assert.equal(report.halt, undefined);
});

test('a user who leaves out --merge gets no wait for the checks on main', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.baseWaits, []);
});

test('a user whose checks on main fail after the merge gets the fix merged through a new pull request', async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.pr, 102);
  assert.deepEqual(target.merged, [101, 102]);
  assert.deepEqual(target.baseWaits, ['merge-of-101', 'merge-of-102']);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.resets, 1);
  assert.equal(target.forcedPushes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.prompts[2]!.prompt, /The checks on main failed after the merge/);
  assert.match(target.prompts[2]!.prompt, /the failed main logs/);
});

test("a user gets the pull request titled with the subject of the implementer's commit", async (t) => {
  const target = await harness(t, { implementerText: ['Done.\ncommit: feat: add the flag'] });
  await target.run();
  assert.deepEqual(target.titles, ['feat: add the flag']);
});

test("a user whose checks on main fail after the merge gets the new pull request titled with the subject of the fixer's commit", async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  await target.run();
  assert.deepEqual(target.titles, ['fix: work on #7', 'fix: repair main']);
});

test('a user who resumes an implemented issue gets the pull request titled with the saved subject', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: { ...SAVED, phase: 'implemented', pr: undefined, title: 'feat: add the saved flag' },
  });
  await target.run();
  assert.deepEqual(target.titles, ['feat: add the saved flag']);
});

test('a user who resumes from a state file without a title gets a conventional pull request title', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: { ...SAVED, phase: 'implemented', pr: undefined },
  });
  await target.run();
  assert.deepEqual(target.titles, ['fix: resolve issue #7']);
});

test('a user whose checks on main fail for an unrelated reason gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.halt, true);
  assert.deepEqual(target.merged, [101]);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main fail for a reason this change did not cause/,
  );
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
});

test('a user whose checks on main fail with no check fix left gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { merge: true, config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
});

test('a user whose checks on main do not finish in time gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { merge: true, baseChecks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks timeout');
  assert.equal(report.halt, true);
});

test('a user who asks to stop after the round while main is watched gets the watch finished first', async (t) => {
  const target = await harness(t, { merge: true, pressDuring: 'reviewer' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
});

test('a base that stays behind goes to the log', async (t) => {
  const target = await harness(t, { baseUpdated: false });
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});

test('a base that the harness fast-forwards writes no such event', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], undefined);
});

test('the status labels go to the issue and to the pull request', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.labels, [
    { kind: 'issue', number: 7, label: 'status:in-progress' },
    { kind: 'issue', number: 7, label: 'status:in-review' },
    { kind: 'pr', number: 101, label: 'status:in-review' },
    { kind: 'issue', number: 7, label: 'status:done' },
    { kind: 'pr', number: 101, label: 'status:done' },
  ]);
});

test('a failed build gives the logs to the fixer and then reviews', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'fixer', 'reviewer']);
  assert.match(target.prompts[1]!.prompt, /the failed job logs/);
  assert.equal(target.pushes, 2);
});

test('a user whose branch is named after the issue number gets the checks read from the pull request number', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(new Set(target.checked), new Set([101]));
});

test('a build that fails after the approval keeps the issue open', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['pass', 'fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(target.ready, []);
  assert.equal(
    target.labels.some((entry) => entry.label === 'status:done'),
    false,
  );
});

test('a build that fails after the approval starts a fix round', async (t) => {
  const target = await harness(t, {
    checks: ['pass', 'fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.deepEqual(target.ready, [101]);
});

test('a fixer that reports an unrelated failure hands over without a commit', async (t) => {
  const target = await harness(t, {
    checks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, []);
  assert.match(
    target.comments.at(-1)!,
    /a reason this change did not cause: product-inventories fails on main too/,
  );
});

test('a fixer that disputes a finding keeps the round going', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.comments[1]!, /### Fixer: no change\n\nthe count follows the convention/);
});

test('a fixer that disputes and leaves a change hands the issue to a person', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.comments.at(-1)!, /left a change behind: the count follows the convention/);
});

test('a fixer that disputes after its own commit hands the issue to a person', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'dispute with changes');
  assert.equal(target.pushes, 1);
});

test('a fixer that disputes after its own commit gets the commit moved off the branch of the pull request', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.equal(target.head(), '2');
});

test('a fixer that reports an unrelated failure after its own commit gets the commit moved off the branch of the pull request', async (t) => {
  const target = await harness(t, {
    selfCommit: true,
    checks: ['fail'],
    fixerText: 'unrelated: product-inventories fails on main too, the diff does not touch it',
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.asides, [{ target: '2', branch: '7-dispute-3' }]);
  assert.equal(target.head(), '2');
});

test('a finished issue gets the dispute branches of an earlier run deleted', async (t) => {
  const target = await harness(t, { disputes: ['7-dispute-3'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.deleted, ['7', '7-dispute-3']);
});

test('a fixer that disputes and leaves only an unclean worktree keeps the branch as it is', async (t) => {
  const target = await harness(t, {
    fixerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  assert.deepEqual(target.asides, []);
});

test('the next reviewer reads the dispute of the fixer', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === 'reviewer')[1]!.prompt;
  assert.match(
    second,
    /The fixer disputed every finding of this round: the count follows the convention in CONTRIBUTING\.md/,
  );
});

test('a reviewer that holds to a disputed finding hands the issue to a person', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), changes('The count is wrong.')],
    fixerText: ['unrelated: the count follows the convention in CONTRIBUTING.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'repeated findings');
});

test('a fixer that changes nothing and says nothing hands the issue to a person', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.')],
    commits: [true, false],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'no fix commit');
});

test('the check budget hands the issue to a person', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 1 }, checks: ['fail', 'fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.match(target.comments.at(-1)!, /needs help: The limit of 1 check fixes/);
  assert.equal((await target.state())?.phase, 'review');
});

test('a check budget of zero stops before the first fix', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['fail'] });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(roles(target), ['implementer']);
});

test('the review budget hands the issue to a person', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 1 },
    verdicts: [changes('The count is wrong.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
});

test('a repeated finding set stops the ping-pong', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), changes('the  count is wrong')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'repeated findings');
  assert.equal(report.reviewRounds, 2);
});

test('the fixer sees the findings once in the first round and the history later', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.'), changes('The name is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  const first = target.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(first, /The count is wrong\./);
  assert.doesNotMatch(first, /Earlier rounds/);
  const second = target.prompts.filter((entry) => entry.role === 'fixer')[1]!.prompt;
  assert.match(second, /## Earlier rounds\nRound 1:\n- The count is wrong\./);
  assert.equal(second.match(/The name is wrong\./g)?.length, 1);
});

test('the later reviewer sees the earlier findings', async (t) => {
  const target = await harness(t, { verdicts: [changes('The count is wrong.'), APPROVE] });
  await target.run();
  const second = target.prompts.filter((entry) => entry.role === 'reviewer')[1]!.prompt;
  assert.match(second, /Earlier findings\nRound 1:\n- The count is wrong\./);
});

test('an implementer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { commits: [false] });
  const report = await target.run();
  assert.equal(report.reason, 'no implementation commit');
  assert.equal(report.pr, undefined);
  assert.equal(target.pushes, 0);
});

test('an implementer that changes nothing on a branch already ahead of the base gets a pull request with the title of the earlier commit', async (t) => {
  const target = await harness(t, { commits: [false], earlier: 'fix: earlier work' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.titles, ['fix: earlier work']);
});

test('a user whose issue is handed over before a pull request exists gets the reason as a comment on the issue', async (t) => {
  const target = await harness(t, { commits: [false] });
  await target.run();
  assert.equal(target.issueNotes.length, 1);
  assert.equal(target.issueNotes[0]!.number, 7);
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
  assert.deepEqual(target.comments, []);
});

test('a user whose issue is handed over after the pull request exists gets the reason on the pull request only', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['fail'] });
  await target.run();
  assert.match(target.comments.at(-1)!, /needs help: /);
  assert.deepEqual(target.issueNotes, []);
});

test('an implementer whose commit fails in a hook gets the hook output and commits the fix', async (t) => {
  const target = await harness(t, { commits: ['oxlint: publicProcedure is never used', true] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'implementer', 'reviewer']);
  assert.match(target.prompts[1]!.prompt, /oxlint: publicProcedure is never used/);
  assert.equal(target.pushes, 1);
  assert.equal(report.ciFixes, 0);
});

test('an implementer whose subject a commit-msg hook rejects commits again with the subject from the fix', async (t) => {
  const target = await harness(t, {
    commits: ['commitlint: subject may not be empty', true],
    implementerText: ['commit: Bad subject', 'commit: fix: count the issues'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^Bad subject\n/);
  assert.match(target.messages[1]!, /^fix: count the issues\n/);
});

test('an implementer whose hook fix names no subject commits again with the earlier subject', async (t) => {
  const target = await harness(t, {
    commits: ['oxlint: x is never used', true],
    implementerText: ['commit: fix: count the issues', 'Fixed the lint error.'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^fix: count the issues\n/);
  assert.match(target.messages[1]!, /^fix: count the issues\n/);
});

test('a fixer whose subject a commit-msg hook rejects commits again with the subject from the fix', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'commitlint: subject may not be empty', true],
    fixerText: ['commit: Bad subject', 'commit: fix: rename the counter'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^Bad subject\n/);
  assert.match(target.messages[2]!, /^fix: rename the counter\n/);
});

test('a fixer whose commit fails in a hook gets the hook output and commits the fix', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'oxlint: x is never used', true],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'fixer', 'reviewer']);
  assert.match(target.prompts[3]!.prompt, /oxlint: x is never used/);
});

test('a commit that keeps failing in a hook hands the issue to a person once maxCommitFixes runs out', async (t) => {
  const target = await harness(t, {
    config: { maxCommitFixes: 1 },
    commits: ['lint fails', 'lint fails'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /lint fails/);
  assert.deepEqual(roles(target), ['implementer', 'implementer']);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.commitFixes, 1);
});

test('a commit that git itself refuses reports an error without a commit fix', async (t) => {
  const target = await harness(t, {
    commits: [new Error('git add -A failed with code 128: index.lock exists')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /index\.lock exists/);
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal((await target.state())?.commitFixes ?? 0, 0);
});

test('a run that finds a corrupt state file reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{ "issue": 7');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json is not valid JSON/);
  assert.deepEqual(roles(target), []);
});

test('a run that finds a state file of the wrong shape reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{}');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json does not hold a valid state/);
  assert.deepEqual(roles(target), []);
});

test('a fixer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['fail'], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.equal(target.pushes, 1);
});

test('a check wait that runs out of time hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.reason, 'checks timeout');
});

test('a person who pushes to the pull request during the check wait gets the issue handed over', async (t) => {
  const target = await harness(t, { checks: ['moved'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'pull request moved');
});

test('a repository without checks goes straight to the review', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  assert.equal((await target.run()).outcome, 'done');
});

test('a user whose pull request conflicts with its base and shows no checks gets the issue handed over with no review', async (t) => {
  const target = await harness(t, { checks: ['none'], conflicts: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.deepEqual(roles(target), ['implementer']);
  assert.match(target.comments.at(-1)!, /conflicts with its base/);
});

test('a user whose pull request conflicts with its base but has passing checks gets the review', async (t) => {
  const target = await harness(t, { checks: ['pass'], conflicts: true });
  assert.equal((await target.run()).outcome, 'done');
});

test('a reviewer without a verdict hands the issue to a person', async (t) => {
  const target = await harness(t, { verdicts: [] });
  const report = await target.run();
  assert.equal(report.reason, 'no verdict');
});

test('a reviewer that says request_changes with no finding still approves', async (t) => {
  const target = await harness(t, {
    verdicts: [
      { verdict: 'request_changes', summary: 'Good.', findings: [] } as unknown as Verdict,
    ],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reviewRounds, 1);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a verdict of the wrong shape counts as no verdict', async (t) => {
  const target = await harness(t, {
    verdicts: [{ summary: 'x' } as unknown as Verdict],
  });
  assert.equal((await target.run()).reason, 'no verdict');
});

test('the reviewer can run commands in the worktree', async (t) => {
  const target = await harness(t);
  await target.run();
  const reviewer = target.profiles.find((entry) => entry.role === 'reviewer')!;
  assert.equal(reviewer.tools.includes('-bash'), false);
  assert.match(target.prompts.at(-1)!.prompt, /run commands to prove what you say/);
});

test('a change that the reviewer leaves never reaches a commit', async (t) => {
  const target = await harness(t, {
    reviewerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
});

test('a minor finding starts a fix round', async (t) => {
  const target = await harness(t, { verdicts: [minor('The name is long.'), APPROVE] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.prompts[2]!.prompt, /The name is long\./);
  assert.match(target.comments[0]!, /Review: changes requested/);
});

test('the last review round leaves a minor finding and approves', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 1 },
    verdicts: [minor('The name is long.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.ready, [101]);
  assert.match(target.comments[0]!, /Review: approved/);
  assert.match(target.comments[0]!, /the review budget is spent/);
});

test('the last review round still hands over a blocking finding', async (t) => {
  const target = await harness(t, {
    config: { maxReviewRounds: 2 },
    verdicts: [minor('The name is long.'), changes('The count is wrong.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'review budget');
  assert.deepEqual(target.ready, []);
});

test('a lock file gives the setup command when the config holds none', async (t) => {
  const target = await harness(t, { detected: 'pnpm install --frozen-lockfile' });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.setups, ['pnpm install --frozen-lockfile']);
});

test('the config setup command wins over the lock file', async (t) => {
  const target = await harness(t, {
    config: { setupCommand: 'make deps' },
    detected: 'pnpm install --frozen-lockfile',
  });
  await target.run();
  assert.deepEqual(target.setups, ['make deps']);
});

test('a project without a lock file runs no setup', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.setups, []);
});

test('a deduced setup command that fails hands the issue to a person', async (t) => {
  const target = await harness(t, { detected: 'npm ci', setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('a setup command that fails hands the issue to a person', async (t) => {
  const target = await harness(t, { config: { setupCommand: 'npm ci' }, setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('a setup command that does not finish hands the issue to a person', async (t) => {
  const target = await harness(t, {
    config: { setupCommand: 'npm ci', setupTimeoutMinutes: 5 },
    setupCode: 1,
    setupTimedOut: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'setup timeout');
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.deepEqual(roles(target), []);
});

test('a diff that is too long is cut before the reviewer reads it', async (t) => {
  const target = await harness(t, { config: { diffMaxChars: 20 }, diff: 'x'.repeat(50) });
  assert.equal((await target.run()).outcome, 'done');
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /The diff is cut here, after 20 characters\./);
  assert.equal(prompt.includes('x'.repeat(21)), false);
});

test('a diff that fits reaches the reviewer whole', async (t) => {
  const target = await harness(t, { diff: 'the whole diff' });
  await target.run();
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /the whole diff/);
  assert.equal(prompt.includes('cut here'), false);
});

test('a step that throws gives the error outcome and hands the issue over', async (t) => {
  const target = await harness(t, { fail: 'push' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.phase, 'implemented');
});

test('a user who asks to stop during the implementation gets the run stopped before the push, with the state kept', async (t) => {
  const target = await harness(t, { pressDuring: 'implementer' });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal(target.pushes, 0);
  assert.equal((await target.state())?.phase, 'implemented');
  assert.equal(target.labels.at(-1)?.label, 'status:in-progress');
});

test('a user who asks to stop during a checks round gets the fix and no review', async (t) => {
  const target = await harness(t, { pressDuring: 'fixer', checks: ['fail', 'pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer', 'fixer']);
  assert.equal((await target.state())?.ciFixes, 1);
});

test('a user who asks to stop during a review round gets the fix and no next review', async (t) => {
  const target = await harness(t, {
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.equal((await target.state())?.reviewRounds, 1);
  assert.equal(target.labels.at(-1)?.label, 'status:in-review');
});

test('a saved state carries on and does not implement again', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: {
      issue: 7,
      phase: 'review',
      branch: 'issue-7',
      pr: 101,
      ciFixes: 2,
      reviewRounds: 1,
      reviewLog: [{ round: 1, fingerprint: 'old', findings: '- old' }],
    },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 2);
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['reviewer']);
  assert.deepEqual(target.branches, ['issue-7']);
  assert.deepEqual(target.starts, [false]);
});

test('a new issue asks for its worktree to start from the base branch', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.starts, [true]);
});

const SAVED: IssueState = {
  issue: 7,
  phase: 'review',
  branch: 'issue-7',
  pr: 101,
  ciFixes: 2,
  reviewRounds: 1,
  reviewLog: [{ round: 1, fingerprint: 'old', findings: '- old' }],
};

test('a user who resumes a run that died after the merge gets the merge carried on without a second pull request', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: SAVED,
    merge: true,
    alreadyMerged: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.pr, 101);
  assert.deepEqual(target.titles, []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.merged, []);
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.equal(await target.state(), undefined);
});

test('a user who resumes a merged run whose checks on main fail gets the fix through a new pull request', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: SAVED,
    merge: true,
    alreadyMerged: true,
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.pr, 101);
  assert.deepEqual(target.baseWaits, ['merge-of-101', 'merge-of-101']);
  assert.deepEqual(roles(target), ['fixer', 'reviewer']);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.titles.length, 1);
});

test('a user who resumes after a merge that closed the issue gets the closed issue back in the list', async (t) => {
  const older: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
  const later: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: true,
    open: [older, later],
    closed: [ISSUE],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 7, 9],
  );
});

test('a user whose open issues arrive out of order gets them oldest first', async (t) => {
  const older: Issue = { ...ISSUE, number: 3, createdAt: '2025-12-01T00:00:00Z' };
  const later: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, { open: [later, older] });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [3, 9],
  );
});

test('a user whose closed issue has a saved state but no merged pull request does not get it back in the list', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: false,
    open: [],
    closed: [ISSUE],
  });
  assert.deepEqual(await pendingIssues(target.context), []);
});

test('a user whose closed issue has a corrupt state file gets it back in the list with an error that names the file', async (t) => {
  const target = await harness(t, { open: [], closed: [ISSUE] });
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{ "issue": 7');
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
  const report = await processIssue(target.context, issues[0]!);
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json is not valid JSON/);
  assert.deepEqual(roles(target), []);
});

test('a user whose open issue has a saved state but lost its status label gets it back in the list', async (t) => {
  const target = await harness(t, {
    saved: SAVED,
    alreadyMerged: false,
    open: [],
    unlisted: [{ ...ISSUE, labels: [] }],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
});

test('a user whose saved issue can no longer be read gets the other issues and an error for that issue', async (t) => {
  const other: Issue = { ...ISSUE, number: 9, createdAt: '2026-02-01T00:00:00Z' };
  const target = await harness(t, {
    saved: SAVED,
    open: [other],
    fail: 'viewIssue',
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [9],
  );
  assert.equal(target.context.recorder.summary().counts['issue.error'], 1);
});

test('a user with a ready label gets only the ready, in-progress and in-review issues asked for', async (t) => {
  const target = await harness(t);
  const asked: string[][] = [];
  target.context.ports.openIssues = async (_repo, _limit, labels) => {
    asked.push(labels);
    return [];
  };
  await pendingIssues(target.context);
  assert.deepEqual(asked, [['status:todo', 'status:in-progress', 'status:in-review']]);
});

test('a user with no ready label gets every open issue asked for', async (t) => {
  const target = await harness(t);
  target.context.config.labels.ready = '';
  const asked: string[][] = [];
  target.context.ports.openIssues = async (_repo, _limit, labels) => {
    asked.push(labels);
    return [];
  };
  await pendingIssues(target.context);
  assert.deepEqual(asked, [[]]);
});

test('a user who resumes without --merge a pull request that a person merged gets the issue done without a wait on main', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: SAVED,
    alreadyMerged: true,
    baseChecks: ['fail'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.titles, []);
  assert.deepEqual(target.reopened, []);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.equal(await target.state(), undefined);
});

test('a user who resumes a run that died in the fix of main gets the fix carried on without another check fix', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: { ...SAVED, ciFixes: 1, baseFix: { sha: 'merge-of-101', head: '-1' } },
    merge: true,
    alreadyMerged: true,
    commits: [false],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.resets, 0);
  assert.equal(target.forcedPushes, 1);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.titles.length, 1);
  assert.deepEqual(roles(target), ['fixer', 'reviewer']);
});

test('--reset puts the budgets back and keeps the resume point', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: SAVED,
    reset: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a user who takes the needs-human label off a handed-over issue gets the budgets put back without --reset', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: { ...SAVED, handedOver: true },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a user who resumes a handed-over issue and stops the run gets the state saved without the mark', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: { ...SAVED, handedOver: true },
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  const state = await target.state();
  assert.equal(state?.handedOver, undefined);
  assert.equal(state?.ciFixes, 0);
});

test('a user who resumes a handed-over issue that is handed over again gets the mark back', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: { ...SAVED, handedOver: true },
    merge: true,
    mergeFails: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  const state = await target.state();
  assert.equal(state?.handedOver, true);
  assert.equal(state?.ciFixes, 0);
});

test('a handed-over issue that still has the needs-human label is not claimed', async (t) => {
  const saved = { ...SAVED, handedOver: true };
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(await target.state(), saved);
});

test('--reset leaves the state of a skipped issue alone', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved: SAVED,
    reset: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(await target.state(), SAVED);
});

test('a skipped issue does nothing', async (t) => {
  const target = await harness(t, { issue: { ...ISSUE, labels: [] } });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('an issue with an open blocker waits without a claim', async (t) => {
  const target = await harness(t, { blockers: ['#3', 'acme/other#9'] });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.context.recorder.summary().counts['issue.skip'], 1);
});

test('a saved issue carries on although a blocker is open', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: SAVED,
    blockers: ['#3'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a blocker read that fails gives the error outcome without a claim', async (t) => {
  const target = await harness(t, { fail: 'openBlockers' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('an agent that commits its own work counts as progress', async (t) => {
  const target = await harness(t, { commits: [false], selfCommit: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 1);
});

test('the checks wait for the commit that was pushed', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.head),
    ['1', '2', '2'],
  );
});

test('a repository without checks pays the grace time once', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.graceMs),
    [60_000, 0],
  );
});

test('a commit that the reviewer makes does not stay on the branch', async (t) => {
  const target = await harness(t, {
    reviewerCommits: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
  assert.equal(await target.context.ports.revision('worktree'), '2');
});
