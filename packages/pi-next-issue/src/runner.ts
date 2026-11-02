import type { Config } from './config.ts';
import {
  cap,
  fixPrompt,
  formatFindings,
  formatVerdict,
  implementPrompt,
  parseCommitSubject,
  parseUnrelated,
  reviewPrompt,
} from './prompts.ts';

export type Issue = { number: number; title: string; body: string; labels: string[] };

export type Finding = { severity: 'blocking' | 'minor'; detail: string };

export type Verdict = { summary: string; findings: Finding[] };

export type ChecksResult = 'pass' | 'fail' | 'timeout';

export type Phase = 'implement' | 'publish' | 'checks' | 'review' | 'merge';

export type IssueState = {
  issue: number;
  branch: string;
  phase: Phase;
  pr?: number;
  title?: string | undefined;
  ciFixes: number;
  round: number;
  earlier: string[];
};

export type AgentTask = {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onTool: (label: string) => void;
};

export type Ports = {
  openIssues(): Promise<Issue[]>;
  comments(issue: number): Promise<string[]>;
  setLabel(issue: number, add: string, remove: string[]): Promise<void>;
  commentOnIssue(issue: number, body: string): Promise<void>;
  worktree(issue: number, branch: string): Promise<string>;
  commit(cwd: string, message: string): Promise<boolean>;
  ahead(cwd: string): Promise<string | undefined>;
  push(cwd: string, branch: string): Promise<void>;
  discard(cwd: string, branch: string): Promise<void>;
  diff(cwd: string): Promise<string>;
  openPr(branch: string, title: string, body: string): Promise<number>;
  checks(pr: number, cwd: string, signal: AbortSignal): Promise<ChecksResult>;
  failedLogs(pr: number): Promise<string>;
  commentOnPr(pr: number, body: string): Promise<void>;
  merge(pr: number, signal: AbortSignal): Promise<MergeResult>;
  cleanup(issue: number, branch: string, cwd: string): Promise<void>;
  work(task: AgentTask): Promise<string>;
  review(task: AgentTask): Promise<Verdict | undefined>;
  readState(issue: number): Promise<IssueState | undefined>;
  writeState(state: IssueState): Promise<void>;
  dropState(issue: number): Promise<void>;
  savedIssues(): Promise<number[]>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
};

export type MergeResult = { merged: true } | { merged: false; reason: string };

export type Outcome = 'merged' | 'needs-human';

export type Status = 'idle' | 'running' | 'stopping' | 'finished' | 'stopped' | 'failed';

export type Progress = {
  status: Status;
  issue?: number | undefined;
  title?: string | undefined;
  stage?: string | undefined;
  tools: number;
  lastTool?: string | undefined;
  issueStartedAt?: number;
  handled: Array<{ issue: number; outcome: Outcome }>;
  error?: string;
};

export const LABELS = {
  ready: 'status:todo',
  inProgress: 'status:in-progress',
  done: 'status:done',
  needsHuman: 'status:needs-human',
  blocked: 'status:blocked',
};

export const STOP_LABELS = [LABELS.inProgress, LABELS.done, LABELS.needsHuman, LABELS.blocked];

function ready(issue: Issue): boolean {
  return (
    issue.labels.includes(LABELS.ready) &&
    !issue.labels.some((label) => STOP_LABELS.includes(label))
  );
}

function resumable(issue: Issue): boolean {
  return !issue.labels.some((label) => label !== LABELS.inProgress && STOP_LABELS.includes(label));
}

export class Runner {
  progress: Progress = { status: 'idle', tools: 0, handled: [] };
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(progress: Progress) => void>();

  private readonly ports: Ports;
  private readonly config: Config;

  constructor(ports: Ports, config: Config) {
    this.ports = ports;
    this.config = config;
  }

  subscribe(listener: (progress: Progress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.progress.status === 'running') {
      this.update({ status: 'stopping' });
    }
    this.controller.abort();
  }

  async run(): Promise<void> {
    this.update({ status: 'running' });
    const seen = new Set<number>();
    let locked = false;
    try {
      await this.ports.lock();
      locked = true;
      for (;;) {
        this.controller.signal.throwIfAborted();
        const issues = await this.ports.openIssues();
        const saved = new Set(await this.ports.savedIssues());
        const fresh = issues.filter((item) => !seen.has(item.number));
        const next =
          fresh.find((item) => saved.has(item.number) && resumable(item)) ??
          fresh.find((item) => ready(item));
        if (next === undefined) {
          this.update({ status: 'finished', stage: undefined, issue: undefined, title: undefined });
          return;
        }
        seen.add(next.number);
        const outcome = await this.handle(next, await this.ports.readState(next.number));
        this.update({ handled: [...this.progress.handled, { issue: next.number, outcome }] });
      }
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.update({ status: 'stopped' });
      } else {
        this.update({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (locked) {
        await this.ports.unlock().catch(() => {});
      }
    }
  }

  private update(change: Partial<Progress>): void {
    this.progress = { ...this.progress, ...change };
    for (const listener of this.listeners) {
      listener(this.progress);
    }
  }

  private stage(stage: string): void {
    this.controller.signal.throwIfAborted();
    this.update({ stage });
  }

  private async agent(kind: 'work', cwd: string, prompt: string): Promise<string>;
  private async agent(kind: 'review', cwd: string, prompt: string): Promise<Verdict | undefined>;
  private async agent(
    kind: 'work' | 'review',
    cwd: string,
    prompt: string,
  ): Promise<string | Verdict | undefined> {
    const task: AgentTask = {
      cwd,
      prompt,
      signal: this.controller.signal,
      onTool: (label) => this.update({ tools: this.progress.tools + 1, lastTool: label }),
    };
    const result = kind === 'work' ? await this.ports.work(task) : await this.ports.review(task);
    this.controller.signal.throwIfAborted();
    return result;
  }

  private async handle(issue: Issue, saved: IssueState | undefined): Promise<Outcome> {
    const { ports, config } = this;
    const number = issue.number;
    this.update({
      issue: number,
      title: issue.title,
      stage: 'prepare',
      tools: 0,
      lastTool: undefined,
      issueStartedAt: Date.now(),
    });
    let state: IssueState = saved ?? {
      issue: number,
      branch: String(number),
      phase: 'implement',
      ciFixes: 0,
      round: 0,
      earlier: [],
    };
    const save = async (change: Partial<IssueState>) => {
      state = { ...state, ...change };
      await ports.writeState(state);
    };
    const needsHuman = async (reason: string): Promise<Outcome> => {
      await ports.setLabel(number, LABELS.needsHuman, [LABELS.inProgress]);
      await ports.commentOnIssue(number, `next-issue stopped: ${reason}`);
      await ports.dropState(number);
      return 'needs-human';
    };
    if (saved === undefined) {
      await ports.setLabel(number, LABELS.inProgress, [LABELS.ready]);
      await ports.writeState(state);
    }
    const comments = await ports.comments(number);
    const cwd = await ports.worktree(number, state.branch);
    const pr = () => {
      if (state.pr === undefined) {
        throw new Error(`the saved state of #${number} holds no pull request`);
      }
      return state.pr;
    };
    for (;;) {
      switch (state.phase) {
        case 'implement': {
          this.stage('implement');
          const kept = saved === undefined ? undefined : await ports.ahead(cwd);
          if (kept !== undefined) {
            await save({ phase: 'publish', title: kept });
            break;
          }
          const reply = await this.agent('work', cwd, implementPrompt(issue, comments));
          const title = parseCommitSubject(reply, `feat: ${issue.title}`);
          if (!(await ports.commit(cwd, title))) {
            return needsHuman('the implementer made no change');
          }
          await save({ phase: 'publish', title });
          break;
        }
        case 'publish': {
          this.stage('pull request');
          await ports.push(cwd, state.branch);
          const title = state.title ?? `feat: ${issue.title}`;
          await save({
            phase: 'checks',
            pr: await ports.openPr(state.branch, title, `Closes #${number}`),
          });
          break;
        }
        case 'checks': {
          this.stage('checks');
          const result = await ports.checks(pr(), cwd, this.controller.signal);
          if (result === 'pass') {
            await save({ phase: 'review' });
            break;
          }
          if (result === 'timeout') {
            return needsHuman('the checks did not finish in time');
          }
          if (state.ciFixes >= config.maxCiFixes) {
            return needsHuman(`the checks still fail after ${config.maxCiFixes} fixes`);
          }
          this.stage(`fix checks ${state.ciFixes + 1}/${config.maxCiFixes}`);
          const logs = cap(await ports.failedLogs(pr()), config.logMaxChars);
          const reply = await this.agent(
            'work',
            cwd,
            fixPrompt(issue, 'The checks failed.', logs, []),
          );
          if (!(await ports.commit(cwd, parseCommitSubject(reply, 'fix: make the checks pass')))) {
            return needsHuman(
              `the fixer made no change: ${parseUnrelated(reply) ?? 'no reason given'}`,
            );
          }
          await ports.push(cwd, state.branch);
          await save({ ciFixes: state.ciFixes + 1 });
          break;
        }
        case 'review': {
          const round = state.round + 1;
          const last = round >= config.maxReviewRounds;
          this.stage(`review ${round}/${config.maxReviewRounds}`);
          const diff = cap(await ports.diff(cwd), config.diffMaxChars);
          const verdict = await this.agent(
            'review',
            cwd,
            reviewPrompt(issue, comments, diff, state.earlier),
          );
          await ports.discard(cwd, state.branch);
          if (verdict === undefined) {
            return needsHuman('the reviewer gave no verdict');
          }
          const open = last
            ? verdict.findings.filter((finding) => finding.severity === 'blocking')
            : verdict.findings;
          await ports.commentOnPr(pr(), formatVerdict(verdict, open));
          if (open.length === 0) {
            await save({ phase: 'merge', round });
            break;
          }
          if (last) {
            return needsHuman('blocking review findings are left after the last round');
          }
          this.stage(`fix review ${round}/${config.maxReviewRounds}`);
          const findings = formatFindings(open);
          const reply = await this.agent(
            'work',
            cwd,
            fixPrompt(issue, 'The reviewer found problems.', findings, state.earlier),
          );
          const committed = await ports.commit(
            cwd,
            parseCommitSubject(reply, 'fix: address the review'),
          );
          const dispute = committed
            ? ''
            : `\nThe fixer disputed every finding of this round: ${parseUnrelated(reply) ?? 'no reason given'}`;
          const earlier = [...state.earlier, `Round ${round}:\n${findings}${dispute}`];
          if (committed) {
            await ports.push(cwd, state.branch);
          }
          await save({ phase: committed ? 'checks' : 'review', round, earlier });
          break;
        }
        case 'merge': {
          this.stage('merge');
          const result = await ports.merge(pr(), this.controller.signal);
          if (!result.merged) {
            return needsHuman(`pull request #${pr()} could not be merged: ${result.reason}`);
          }
          await ports.setLabel(number, LABELS.done, [LABELS.inProgress]);
          await ports.cleanup(number, state.branch, cwd);
          await ports.dropState(number);
          return 'merged';
        }
      }
    }
  }
}
