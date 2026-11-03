import type { Issue } from './github.mts';
import { type Context, type IssueReport, type Outcome, type Run, setStatus } from './job.mts';
import { message, type Recorder } from './observe.mts';
import { dropState, type IssueState, writeState } from './state.mts';

export function escalate(job: Run, reason: string): Promise<void> {
  return handOver(job.context, job.log, job.issue.number, job.state, reason);
}

export function stop(job: Run): IssueReport {
  const { issue, log, state } = job;
  log.event('issue.stop', { phase: state.phase }, 'quiet');
  return {
    issue: issue.number,
    outcome: 'stopped',
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - job.started,
  };
}

export async function finish(job: Run, outcome: Outcome, reason?: string): Promise<IssueReport> {
  const { context, issue, log, state, branch } = job;
  const { repo, ports } = context;
  await cleanUp(context, log, branch);
  if (outcome === 'done') {
    for (const name of [branch, ...(await ports.disputeBranches(repo, branch))]) {
      if (!(await ports.deleteBranch(repo, name))) {
        log.event('branch.kept', { branch: name }, 'quiet');
      }
    }
    await dropState(repo, issue.number);
  }
  return {
    issue: issue.number,
    outcome,
    reason,
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - job.started,
    ...(job.mainBroken && outcome !== 'done' ? { halt: true } : {}),
  };
}

export async function cleanUp(context: Context, log: Recorder, branch: string): Promise<void> {
  try {
    const path = await context.ports.findWorktree(context.repo, branch);
    if (path === undefined) {
      return;
    }
    if (!(await context.ports.removeWorktree(context.repo, path))) {
      log.event('worktree.kept', { path }, 'quiet');
    }
  } catch (error) {
    log.event('worktree.error', { error: message(error) }, 'quiet');
  }
}

export async function handOver(
  context: Context,
  log: Recorder,
  issue: number,
  state: IssueState,
  reason: string,
): Promise<void> {
  log.event('hand-over', { reason }, 'quiet');
  await writeState(context.repo, state);
  await setStatus(context, issue, state.pr, context.config.labels.needsHuman);
  const body = `next-issue needs help: ${reason}`;
  if (state.pr === undefined) {
    await context.ports.commentOnIssue(context.repo, issue, body);
  } else {
    await context.ports.commentOnPr(context.repo, state.pr, body);
  }
}

export function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
