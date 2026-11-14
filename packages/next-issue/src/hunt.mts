import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REVIEWING } from './agents.mts';
import { minutesToMs } from './durations.mts';
import { readTextIfPresent } from './files.mts';
import { git, remoteRef, type Repo, resetHard } from './git.mts';
import type { Context } from './job.mts';
import { oneAtATime } from './lock.mts';
import { huntPrompt } from './prompts.mts';
import { skipReason } from './skip.mts';
import type { Hunter } from './watch.mts';
import { WORKTREE_DIR } from './worktree.mts';

export const HUNT_FILE = 'next-issue.hunt.md';

const FILED = /^issue:\s*(\S+)\s*$/gm;

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

export async function hunt(context: Context, count: number): Promise<boolean> {
  const { repo, config, base, recorder, ports } = context;
  return recorder.step('hunt', {}, async () => {
    const cwd = await oneAtATime(repo.root, () => ports.huntWorktree(repo, base, config.remote));
    await ports.ensureLabel(repo, config.labels.hunt);
    const instructions = await readTextIfPresent(join(repo.root, HUNT_FILE));
    const result = await ports.runAgent(recorder, {
      name: 'hunter',
      cwd,
      prompt: huntPrompt(instructions, config.labels.ready, config.labels.hunt, count),
      profile: REVIEWING,
      timeoutMs: minutesToMs(config.agentTimeoutMinutes),
    });
    const urls = [...result.text.matchAll(FILED)]
      .map((match) => match[1]!)
      .filter((url) => /^https?:\/\//.test(url));
    for (const url of urls.length === 0 ? ['none'] : urls) {
      recorder.event('hunt.issue', { url }, 'quiet');
    }
    return urls.length > 0;
  });
}

export function hunter(context: Context): Hunter & { busy: () => boolean } {
  const { repo, config, recorder, ports } = context;
  const { ready } = config.labels;
  const labels = ready.length === 0 ? [] : [ready];
  let hunting = false;
  return {
    cap: config.huntCap,
    ready: async (running) => {
      const open = (await ports.openIssues(repo, config.issueLimit, labels)).filter(
        (issue) => skipReason(issue, config, false) === undefined,
      );
      const claimable = new Set(open.map((issue) => issue.number));
      const blockers = await Promise.all(
        open.map((issue) => ports.openBlockers(repo, issue.number)),
      );
      return open.filter((_issue, index) =>
        blockers[index]!.every((blocker) => {
          const number = Number(/^#(\d+)$/.exec(blocker)?.[1]);
          return running.has(number) || claimable.has(number);
        }),
      );
    },
    hunt: async (count) => {
      hunting = true;
      try {
        return await hunt(context, count);
      } catch {
        return false;
      } finally {
        hunting = false;
      }
    },
    wait: (minutes, signal) => {
      recorder.event('hunt.wait', { minutes });
      return delay(minutesToMs(minutes), undefined, { signal }).catch(() => undefined);
    },
    busy: () => hunting,
  };
}
