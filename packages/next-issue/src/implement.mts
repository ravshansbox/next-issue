import { parseCommitSubject } from './agent-reply.mts';
import { CODING } from './agents.mts';
import { commitWork } from './fix.mts';
import { escalateAndFinish } from './handover.mts';
import { fallbackTitle, type Round, type Run, runRole } from './job.mts';
import { implementPrompt } from './prompts.mts';
import { writeState } from './state.mts';

export async function implement(job: Run): Promise<Round> {
  const { context, issue, log, state, worktree, comments, reply } = job;
  const before = await context.ports.revision(worktree);
  const result = await log.step('implement', {}, () =>
    runRole(job, 'implementer', implementPrompt(issue, comments, reply), CODING),
  );
  const subject = parseCommitSubject(result.text, fallbackTitle(issue));
  if (!(await commitWork(job, before, subject, 'implementer'))) {
    const escalated = await useEarlierCommit(job);
    if (escalated !== undefined) {
      return escalated;
    }
  }
  state.phase = 'implemented';
  await writeState(context.repo, state);
  return { done: false };
}

async function useEarlierCommit(job: Run): Promise<Round | undefined> {
  const { context, log, state, worktree } = job;
  const earlier = await context.ports.latestSubject(worktree, context.base, context.config.remote);
  if (earlier === undefined) {
    return escalateAndFinish(
      job,
      'The implementer produced no change.',
      'no implementation commit',
    );
  }
  log.event('implement.earlier', { subject: earlier }, 'quiet');
  state.title = earlier;
  return undefined;
}
