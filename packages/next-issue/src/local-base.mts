import type { Run } from './job.mts';
import { oneAtATime } from './lock.mts';

export async function updateLocalBase(job: Run): Promise<void> {
  const { context, log } = job;
  const { repo, ports, config, base } = context;
  const updated = await oneAtATime(repo.root, () =>
    ports.fastForwardBase(repo, base, config.remote),
  ).catch(() => false);
  if (!updated) {
    log.event('base.behind', { base }, 'quiet');
  }
}
