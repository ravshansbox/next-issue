import { escalateAndFinish } from '../shared/handover.mts';
import type { Finished, Run } from '../shared/job.mts';
import { heldOnBase, unsettledNote } from '../shared/unsettled.mts';

/** Hands the issue over when a person without write access last changed its title or body; otherwise gives the job the title and body checked. */
export async function untrustedEditors(job: Run): Promise<Finished | undefined> {
  const { context, issue, log } = job;
  const { repo, ports } = context;
  const { title, body, editors } = await log.step('editors', {}, () =>
    ports.issueEditors(repo, issue.number),
  );
  const untrusted: Array<{ part: string; login: string }> = [];
  for (const [part, login] of [
    ['title', editors.title],
    ['body', editors.body],
  ] as const) {
    if (!(await ports.canWrite(repo, login))) {
      untrusted.push({ part, login });
    }
  }
  if (untrusted.length === 0) {
    job.issue = { ...issue, title, body };
    return undefined;
  }
  const changed = untrusted
    .map(
      ({ part, login }) =>
        `the ${part} was last changed by @${login}, who has no write access to the repository`,
    )
    .join('; ');
  const parts = untrusted.map(({ part }) => `the ${part}`).join(' and ');
  const held = heldOnBase(job.state, context.base);
  if (held !== '') {
    job.mainBroken = true;
    job.state.halted = true;
  }
  const unsettled = held === '' ? '' : unsettledNote(held, 'This resume stopped');
  return escalateAndFinish(
    job,
    `The worker did not send the issue to an agent: ${changed}. A person with write access can check the issue, then change ${parts} to go on.${unsettled}`,
    'untrusted editor',
  );
}
