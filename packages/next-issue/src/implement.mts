import { parseCommitSubject } from './agent-reply.mts';
import { CODING } from './agents.mts';
import { commitWork } from './fix.mts';
import { HAND_OVER } from './hand-over-comments.mts';
import { escalateAndFinish } from './handover.mts';
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
const COMMENT_LIMIT = 65536;
const CUT = '\n\nThe reply was too long for a GitHub comment and was cut.';

function noChangeNote(reply: string): string {
  const text = reply.trim();
  if (text === '') {
    return NO_CHANGE;
  }
  const note = `${NO_CHANGE}\n\n${text}`;
  const room = COMMENT_LIMIT - HAND_OVER.length - 1;
  return note.length > room ? `${note.slice(0, room - CUT.length)}${CUT}` : note;
}
