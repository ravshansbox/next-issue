import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEWING } from './agents.mts';
import { minutesToMs } from './durations.mts';
import { readTextIfPresent } from './files.mts';
import { git, remoteRef, type Repo, resetHard } from './git.mts';
import type { Context } from './job.mts';
import { oneAtATime } from './lock.mts';
import { huntPrompt } from './prompts.mts';
import { WORKTREE_DIR } from './worktree.mts';

export const HUNT_FILE = 'next-issue.hunt.md';

const FILED = /^issue:\s*(\S+)\s*$/m;

export async function huntWorktree(repo: Repo, base: string, remote: string): Promise<string> {
  const path = join(repo.root, WORKTREE_DIR, 'hunt');
  const target = remoteRef(remote, base);
  await git(repo.root, ['fetch', remote]);
  await git(repo.root, ['worktree', 'prune']);
  if (existsSync(join(path, '.git'))) {
    await resetHard(path, target);
  } else {
    await git(repo.root, ['worktree', 'add', '--detach', path, target]);
  }
  return path;
}

export async function hunt(context: Context): Promise<void> {
  const { repo, config, base, recorder, ports } = context;
  await recorder.step('hunt', {}, async () => {
    const cwd = await oneAtATime(repo.root, () => ports.huntWorktree(repo, base, config.remote));
    const instructions = await readTextIfPresent(join(repo.root, HUNT_FILE));
    const result = await ports.runAgent(recorder, {
      name: 'hunter',
      cwd,
      prompt: huntPrompt(instructions, config.labels.ready),
      profile: REVIEWING,
      timeoutMs: minutesToMs(config.agentTimeoutMinutes),
    });
    recorder.event('hunt.issue', { url: FILED.exec(result.text)?.[1] ?? 'none' }, 'quiet');
  });
}
