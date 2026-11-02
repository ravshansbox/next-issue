import type { Config } from '../src/config.ts';
import type {
  AgentTask,
  ChecksResult,
  Issue,
  IssueState,
  MergeResult,
  Ports,
  Verdict,
} from '../src/runner.ts';

export const CONFIG: Config = {
  remote: 'origin',
  maxCiFixes: 2,
  maxReviewRounds: 2,
  checkTimeoutMinutes: 1,
  diffMaxChars: 1000,
  logMaxChars: 1000,
};

type Script = {
  issues?: Issue[];
  states?: IssueState[];
  checks?: ChecksResult[];
  verdicts?: Array<Verdict | undefined>;
  replies?: string[];
  commits?: boolean[];
  ahead?: string;
  merge?: MergeResult;
  onWork?: (task: AgentTask) => void | Promise<void>;
  failOn?: string;
  lockedByOther?: boolean;
};

export function issue(number: number, labels = ['status:todo']): Issue {
  return { number, title: `issue ${number}`, body: 'body', labels };
}

export function clean(): Verdict {
  return { summary: 'fine', findings: [] };
}

export function fake(script: Script) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const states = new Map((script.states ?? []).map((state) => [state.issue, state]));
  const checks = [...(script.checks ?? [])];
  const verdicts = [...(script.verdicts ?? [])];
  const replies = [...(script.replies ?? [])];
  const commits = [...(script.commits ?? [])];
  const lock = { held: false };
  const record = (call: string) => {
    calls.push(call);
    if (script.failOn !== undefined && call.startsWith(script.failOn)) {
      throw new Error(`${call} broke`);
    }
  };
  const ports: Ports = {
    openIssues: async () => script.issues ?? [],
    comments: async () => [],
    setLabel: async (number, add, remove) =>
      record(`label #${number} +${add} -${remove.join(',')}`),
    commentOnIssue: async (number, body) => record(`issue comment #${number} ${body}`),
    worktree: async (number, branch) => {
      record(`worktree #${number} ${branch}`);
      return `/wt/${number}`;
    },
    commit: async (_cwd, message) => {
      record(`commit ${message}`);
      return commits.shift() ?? true;
    },
    ahead: async () => script.ahead,
    push: async (_cwd, branch) => record(`push ${branch}`),
    discard: async (cwd, branch) => record(`discard ${cwd} ${branch}`),
    diff: async () => 'diff --git a/x b/x',
    openPr: async (branch, title, body) => {
      record(`pr ${branch} ${title} ${body}`);
      return 50;
    },
    checks: async (pr) => {
      record(`checks #${pr}`);
      return checks.shift() ?? 'pass';
    },
    failedLogs: async () => 'test x failed',
    commentOnPr: async (pr, body) => record(`pr comment #${pr} ${body.split('\n')[0]}`),
    merge: async (pr) => {
      record(`merge #${pr}`);
      return script.merge ?? { merged: true };
    },
    cleanup: async (number) => record(`cleanup #${number}`),
    work: async (task) => {
      record('work');
      prompts.push(task.prompt);
      await script.onWork?.(task);
      return replies.shift() ?? 'done\ncommit: feat: do it';
    },
    review: async (task) => {
      record('review');
      prompts.push(task.prompt);
      return verdicts.length > 0 ? verdicts.shift() : clean();
    },
    readState: async (number) => states.get(number),
    writeState: async (state) => {
      states.set(state.issue, state);
    },
    dropState: async (number) => {
      record(`drop #${number}`);
      states.delete(number);
    },
    savedIssues: async () => [...states.keys()],
    lock: async () => {
      if (script.lockedByOther === true) {
        throw new Error('another run works on this repository (pid 1)');
      }
      lock.held = true;
    },
    unlock: async () => {
      lock.held = false;
    },
  };
  return { ports, calls, prompts, states, lock };
}
