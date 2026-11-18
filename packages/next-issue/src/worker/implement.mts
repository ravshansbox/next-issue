import { parseCommitSubject, parseDone, parseQuestions } from './agent-reply.mts';
import { CODING, REVIEWING } from '../shared/agents.mts';
import { message } from '../shared/errors.mts';
import { commitWork } from './fix.mts';
import { escalateAndFinish, finishDone } from '../shared/handover.mts';
import { numbered, withOpenQuestions } from '../shared/issue-format.mts';
import {
  fallbackTitle,
  type Finished,
  ROUND_CONTINUE,
  type Round,
  type Run,
  runRole,
} from '../shared/job.mts';
import { donePrompt, implementPrompt } from '../shared/prompts.mts';
import { undoingReview } from './review.mts';
import { writeState } from '../shared/state.mts';
import { agentHeading } from '../shared/text.mts';
import { blockingFindings, formatFindings, parseVerdict } from './verdict.mts';

export async function implement(job: Run): Promise<Round> {
  const { context, issue, log, state, worktree, comments, reply } = job;
  const before = await context.ports.revision(worktree);
  const result = await log.step('implement', {}, () =>
    runRole(
      job,
      'implementer',
      implementPrompt(issue, comments, reply, state.unpostedQuestions),
      CODING,
    ),
  );
  state.implementerReply = result.text;
  delete state.unpostedQuestions;
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
  const { context, issue, log, state, worktree, branch } = job;
  const { repo, ports } = context;
  await ports.discardChanges(worktree, before, branch);
  try {
    const fresh = await ports.issueEditors(repo, issue.number);
    if (await ports.canWrite(repo, fresh.editors.body)) {
      await ports.editIssueBody(repo, issue.number, withOpenQuestions(fresh.body, questions));
    } else {
      log.event('questions.body-untrusted', { editor: fresh.editors.body });
      state.unpostedQuestions = questions;
    }
  } catch (error) {
    log.event('questions.body-failed', { error: message(error) });
    state.unpostedQuestions = questions;
  }
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
    const evidence = parseDone(state.implementerReply ?? '');
    if (evidence !== undefined) {
      return closeIfDone(job, evidence);
    }
    return escalateAndFinish(
      job,
      noChangeNote(state.implementerReply ?? ''),
      'no implementation commit',
    );
  }
  log.event('implement.earlier', { subject: earlier });
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

async function closeIfDone(job: Run, evidence: string): Promise<Finished> {
  const { context, issue, log, state, worktree, comments } = job;
  const before = await context.ports.revision(worktree);
  state.reviewing = before;
  await writeState(context.repo, state);
  const review = await undoingReview(job, before, () =>
    log.step('review', { alreadyDone: true }, () =>
      runRole(job, 'reviewer', donePrompt(issue, comments, evidence), REVIEWING),
    ),
  );
  const verdict = parseVerdict(review.text);
  const blocking = verdict === undefined ? [] : blockingFindings(verdict);
  if (verdict === undefined || blocking.length > 0) {
    const findings =
      verdict === undefined
        ? 'The reviewer gave no verdict.'
        : `The reviewer disagreed:\n\n${formatFindings(blocking)}`;
    return escalateAndFinish(
      job,
      `The implementer produced no change and said the issue is already done: ${evidence}\n\n${findings}`,
      'already done disputed',
    );
  }
  return finishDone(
    job,
    `${agentHeading('Worker', 'already done')}\n\n${evidence}\n\nReview: ${verdict.summary}`,
  );
}
