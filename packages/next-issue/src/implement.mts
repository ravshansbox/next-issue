import { parseCommitSubject, parseQuestions } from './agent-reply.mts';
import { CODING } from './agents.mts';
import { commitWork } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { numbered, withOpenQuestions } from './issue-format.mts';
import { fallbackTitle, ROUND_CONTINUE, type Round, type Run, runRole } from './job.mts';
import { implementPrompt } from './prompts.mts';
import { writeState } from './state.mts';

export async function implement(job: Run): Promise<Round> {
  const { context, issue, log, state, worktree, comments, reply } = job;
  const before = await context.ports.revision(worktree);
  const result = await log.step('implement', {}, () =>
    runRole(job, 'implementer', implementPrompt(issue, comments, reply), CODING),
  );
  state.implementerReply = result.text;
  const questions = parseQuestions(result.text);
  if (questions.length > 0) {
    return askQuestions(job, before, questions);
  }
  const subject = parseCommitSubject(result.text, fallbackTitle(issue));
  if (!(await commitWork(job, before, subject, 'implementer'))) {
    const escalated = await useEarlierCommit(job);
    if (escalated !== undefined) {
      return escalated;
    }
  }
  state.phase = 'implemented';
  await writeState(context.repo, state);
  return ROUND_CONTINUE;
}

async function askQuestions(job: Run, before: string, questions: string[]): Promise<Round> {
  const { context, issue, worktree, branch } = job;
  const { repo, ports } = context;
  await ports.discardChanges(worktree, before, branch);
  const fresh = await ports.viewIssue(repo, issue.number);
  await ports.editIssueBody(repo, issue.number, withOpenQuestions(fresh.body, questions));
  return escalateAndFinish(
    job,
    `The implementer has questions about the issue.\n\n${numbered(questions)}`,
    'questions',
  );
}

async function useEarlierCommit(job: Run): Promise<Round | undefined> {
  const { context, log, state, worktree } = job;
  const earlier = await context.ports.latestSubject(worktree, context.base, context.config.remote);
  if (earlier === undefined) {
    return escalateAndFinish(
      job,
      noChangeNote(state.implementerReply ?? ''),
      'no implementation commit',
    );
  }
  log.event('implement.earlier', { subject: earlier }, 'quiet');
  state.title = earlier;
  return undefined;
}

const NO_CHANGE = 'The implementer produced no change.';

function noChangeNote(reply: string): string {
  const text = reply.trim();
  if (text === '') {
    return NO_CHANGE;
  }
  return `${NO_CHANGE}\n\n${text}`;
}
