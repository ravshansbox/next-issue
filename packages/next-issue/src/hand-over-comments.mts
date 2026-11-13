import type { Config } from './config.mts';
import { slug } from './gh.mts';
import type { Repo } from './git.mts';
import type { Comment, Issue } from './github.mts';
import type { Context } from './job.mts';
import type { Recorder } from './observe.mts';
import type { Ports } from './ports.mts';
import type { Question } from './protocol.mts';

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
    questions.push(await waitingQuestion(repo, config, ports, writer, issue));
  }
  return questions;
}

async function waitingQuestion(
  repo: Repo,
  config: Config,
  ports: QuestionPorts,
  writer: Writer,
  issue: Issue,
): Promise<Question> {
  const { comments, last } = await handOverThread(repo, ports, writer, issue.number);
  const comment = comments[last];
  return {
    issue: issue.number,
    title: issue.title,
    reason: comment?.body.slice(HAND_OVER.length).trim() ?? '',
    url: comment?.url ?? '',
    repo: slug(repo),
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

export async function handOverReply(context: Context, issue: number): Promise<string[]> {
  const { repo, ports } = context;
  const writer = writers(repo, ports);
  const { comments, last } = await handOverThread(repo, ports, writer, issue);
  if (last === -1) {
    return [];
  }
  return writerQuotes(comments.slice(last + 1), writer);
}
