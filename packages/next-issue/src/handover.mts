import type { Config } from './config.mts';
import type { Repo } from './git.mts';
import type { Comment, Issue } from './github.mts';
import { type Context, type IssueReport, type Outcome, type Run, setStatus } from './job.mts';
import { message, type Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import type { Question } from './protocol.mts';
import { dropState, type IssueState, readState, writeState } from './state.mts';

export const HAND_OVER = 'next-issue needs help:';

type Writer = (author: string) => Promise<boolean>;

function writers(repo: Repo, ports: Pick<Ports, 'canWrite'>): Writer {
  const access = new Map<string, Promise<boolean>>();
  return (author) => {
    if (!access.has(author)) {
      access.set(author, ports.canWrite(repo, author));
    }
    return access.get(author)!;
  };
}

async function lastHandOver(comments: Comment[], writer: Writer): Promise<number> {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]!;
    if (comment.body.startsWith(HAND_OVER) && (await writer(comment.author))) {
      return index;
    }
  }
  return -1;
}

export async function waitingQuestions(
  repo: Repo,
  config: Config,
  ports: Pick<Ports, 'canWrite' | 'openIssues' | 'threadComments'>,
): Promise<Question[]> {
  const writer = writers(repo, ports);
  const issues = await ports.openIssues(repo, config.issueLimit, [config.labels.needsHuman]);
  const questions: Question[] = [];
  for (const issue of issues) {
    const pr = (await readState(repo, issue.number))?.pr;
    const comments = await ports.threadComments(repo, pr ?? issue.number);
    const comment = comments[await lastHandOver(comments, writer)];
    questions.push({
      issue: issue.number,
      title: issue.title,
      reason: comment?.body.slice(HAND_OVER.length).trim() ?? '',
      url: comment?.url ?? '',
    });
  }
  return questions;
}

export async function handOverReply(
  context: Context,
  issue: number,
  pr: number | undefined,
): Promise<string[]> {
  const { repo, ports } = context;
  const comments = await ports.threadComments(repo, pr ?? issue);
  const writer = writers(repo, ports);
  const last = await lastHandOver(comments, writer);
  if (last === -1) {
    return [];
  }
  const reply: string[] = [];
  for (const comment of comments.slice(last + 1)) {
    if (await writer(comment.author)) {
      reply.push(`@${comment.author}: ${comment.body}`);
    }
  }
  return reply;
}

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
  await writeState(context.repo, { ...state, handedOver: true });
  await setStatus(context, issue, state.pr, context.config.labels.needsHuman);
  const body = `${HAND_OVER} ${reason}`;
  if (state.pr === undefined) {
    await context.ports.commentOnIssue(context.repo, issue, body);
  } else {
    await context.ports.commentOnPr(context.repo, state.pr, body);
  }
}

export function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
