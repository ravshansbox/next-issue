import type { Config } from './config.mts';
import { repoArg } from './gh.mts';
import type { Repo } from './git.mts';
import type { Comment, Issue } from './github.mts';
import type { Context } from './job.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import type { Question } from './protocol.mts';
import { type PendingHandOver, readState } from './state.mts';

export const HAND_OVER = 'next-issue needs help:';

const HARNESS_HEADINGS = [HAND_OVER, '### Review:', '### Fixer:'];

function fromHarness(comment: Comment): boolean {
  return HARNESS_HEADINGS.some((heading) => comment.body.startsWith(heading));
}

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

async function writerQuotes(
  comments: Comment[],
  writer: Writer,
  skip: (comment: Comment) => void = () => {},
): Promise<string[]> {
  const kept: string[] = [];
  for (const comment of comments) {
    if (await writer(comment.author)) {
      kept.push(quote(comment));
    } else {
      skip(comment);
    }
  }
  return kept;
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

type ThreadPorts = Pick<Ports, 'canWrite' | 'threadComments'>;

async function handOverThread(
  repo: Repo,
  ports: ThreadPorts,
  writer: Writer,
  issue: number,
): Promise<{ comments: Comment[]; last: number }> {
  const comments = await ports.threadComments(repo, issue);
  return { comments, last: await lastHandOver(comments, writer) };
}

type QuestionPorts = ThreadPorts & Pick<Ports, 'openIssues'>;

export async function waitingQuestions(
  repo: Repo,
  config: Config,
  ports: QuestionPorts,
): Promise<Question[]> {
  const writer = writers(repo, ports);
  const issues = await ports.openIssues(repo, config.issueLimit, [config.labels.needsHuman]);
  const questions: Question[] = [];
  for (const issue of issues) {
    const question = await waitingQuestion(repo, config, ports, writer, issue);
    if (question) {
      questions.push(question);
    }
  }
  return questions;
}

function postedAfter(comment: Comment, since: string | undefined): boolean {
  return since !== undefined && comment.createdAt !== undefined && comment.createdAt > since;
}

/** With a pending hand-over, only comments after it answer; without its time, none do. */
function answerCandidates(
  comments: Comment[],
  last: number,
  pending: PendingHandOver | undefined,
): Comment[] {
  if (pending !== undefined) {
    return comments.filter((comment) => postedAfter(comment, pending.since));
  }
  return last === -1 ? [] : comments.slice(last + 1);
}

async function replyAfter(
  comments: Comment[],
  last: number,
  writer: Writer,
  pending?: PendingHandOver,
): Promise<string[]> {
  return writerQuotes(
    answerCandidates(comments, last, pending).filter((comment) => !fromHarness(comment)),
    writer,
  );
}

async function pendingHandOver(repo: Repo, issue: number): Promise<PendingHandOver | undefined> {
  try {
    return (await readState(repo, issue))?.pendingHandOver;
  } catch {
    return undefined;
  }
}

async function waitingQuestion(
  repo: Repo,
  config: Config,
  ports: QuestionPorts,
  writer: Writer,
  issue: Issue,
): Promise<Question | undefined> {
  const { comments, last } = await handOverThread(repo, ports, writer, issue.number);
  const pending = await pendingHandOver(repo, issue.number);
  if ((await replyAfter(comments, last, writer, pending)).length > 0) {
    return undefined;
  }
  const latest = comments[last];
  const comment =
    pending === undefined || (latest !== undefined && postedAfter(latest, pending.since))
      ? latest
      : undefined;
  return {
    issue: issue.number,
    title: issue.title,
    reason: comment?.body.slice(HAND_OVER.length).trim() ?? pending?.reason ?? '',
    url: comment?.url ?? '',
    repo: repoArg(repo),
    labels: { needsHuman: config.labels.needsHuman, skip: config.labels.skip },
  };
}

export async function writerComments(
  context: Context,
  log: Recorder,
  issue: number,
): Promise<string[]> {
  const { repo, ports } = context;
  const comments = (await ports.issueComments(repo, issue)).filter(
    (comment) => !fromHarness(comment),
  );
  return writerQuotes(comments, writers(repo, ports), (comment) =>
    log.event('comment.skip', { author: comment.author }, 'quiet'),
  );
}

export async function handOverReply(
  context: Context,
  issue: number,
  pending?: PendingHandOver,
): Promise<string[]> {
  const { repo, ports } = context;
  const writer = writers(repo, ports);
  const { comments, last } = await handOverThread(repo, ports, writer, issue);
  return replyAfter(comments, last, writer, pending);
}

/** The time of the newest thread comment, `''` for an empty thread, `undefined` when the thread cannot be read. */
export async function threadEnd(context: Context, issue: number): Promise<string | undefined> {
  try {
    const comments = await context.ports.threadComments(context.repo, issue);
    return comments.reduce((end, comment) => {
      const at = comment.createdAt ?? '';
      return at > end ? at : end;
    }, '');
  } catch {
    return undefined;
  }
}
