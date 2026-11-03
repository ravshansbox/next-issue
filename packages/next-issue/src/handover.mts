import type { Config } from './config.mts';
import type { Repo } from './git.mts';
import type { Comment, Issue } from './github.mts';
import {
  type Context,
  type IssueReport,
  type Outcome,
  oneAtATime,
  type Run,
  setStatus,
} from './job.mts';
import { message, type Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import type { Question } from './protocol.mts';
import { dropState, type IssueState, readState, writeState } from './state.mts';

const HAND_OVER = 'next-issue needs help:';

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

function quote(comment: Comment): string {
  return `@${comment.author}: ${comment.body}`;
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
      repo: `${repo.owner}/${repo.name}`,
      ...(pr === undefined ? {} : { pr }),
      labels: { needsHuman: config.labels.needsHuman, skip: config.labels.skip },
    });
  }
  return questions;
}

export async function writerComments(
  context: Context,
  log: Recorder,
  issue: number,
): Promise<string[]> {
  const { repo, ports } = context;
  const writer = writers(repo, ports);
  const kept: string[] = [];
  for (const comment of await ports.issueComments(repo, issue)) {
    if (await writer(comment.author)) {
      kept.push(quote(comment));
    } else {
      log.event('comment.skip', { author: comment.author }, 'quiet');
    }
  }
  return kept;
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
      reply.push(quote(comment));
    }
  }
  return reply;
}

export function escalate(job: Run, reason: string): Promise<void> {
  return handOver(job.context, job.log, job.issue.number, job.state, reason);
}

export async function escalateAndFinish(
  job: Run,
  note: string,
  reason: string,
): Promise<{ done: true; report: IssueReport }> {
  await escalate(job, note);
  return { done: true, report: await finish(job, 'needs-human', reason) };
}

export function stop(job: Run): IssueReport {
  const { issue, log, state } = job;
  log.event('issue.stop', { phase: state.phase }, 'quiet');
  return {
    issue: issue.number,
    outcome: 'stopped',
    ...progress(job),
  };
}

function progress(job: Run): Pick<IssueReport, 'pr' | 'ciFixes' | 'reviewRounds' | 'ms'> {
  const { state } = job;
  return {
    pr: state.pr,
    ciFixes: state.ciFixes,
    reviewRounds: state.reviewRounds,
    ms: Date.now() - job.started,
  };
}

export async function finish(job: Run, outcome: Outcome, reason?: string): Promise<IssueReport> {
  const { context, issue, log, branch } = job;
  const { repo, ports } = context;
  await cleanUp(context, log, branch);
  if (outcome === 'done') {
    for (const name of [branch, ...(await ports.disputeBranches(repo, branch))]) {
      if (!(await oneAtATime(repo.root, () => ports.deleteBranch(repo, name)))) {
        log.event('branch.kept', { branch: name }, 'quiet');
      }
    }
    await dropState(repo, issue.number);
  }
  return {
    issue: issue.number,
    outcome,
    reason,
    ...progress(job),
    ...(job.mainBroken && outcome !== 'done' ? { halt: true } : {}),
  };
}

export async function cleanUp(context: Context, log: Recorder, branch: string): Promise<void> {
  const { repo, ports } = context;
  try {
    const path = await ports.findWorktree(repo, branch);
    if (path === undefined) {
      return;
    }
    if (!(await oneAtATime(repo.root, () => ports.removeWorktree(repo, path)))) {
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
  const { repo, ports, config } = context;
  log.event('hand-over', { reason }, 'quiet');
  await writeState(repo, { ...state, handedOver: true });
  await setStatus(context, issue, state.pr, config.labels.needsHuman);
  const body = `${HAND_OVER} ${reason}`;
  if (state.pr === undefined) {
    await ports.commentOnIssue(repo, issue, body);
  } else {
    await ports.commentOnPr(repo, state.pr, body);
  }
}

export function skipped(issue: Issue): IssueReport {
  return { issue: issue.number, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 };
}
