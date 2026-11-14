import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REVIEWING } from './agents.mts';
import { minutesToMs } from './durations.mts';
import { readTextIfPresent } from './files.mts';
import { slug } from './gh.mts';
import { git, gitFetch, remoteRef, type Repo } from './git.mts';
import type { Context } from './job.mts';
import { oneAtATime } from './lock.mts';
import { huntPrompt } from './prompts.mts';
import { skipReason } from './skip.mts';
import type { Hunter } from './watch.mts';
import { huntPath } from './worktree.mts';

export const HUNT_FILE = 'next-issue.hunt.md';

const FILED = /^issue:[^\S\r\n]*(\S+)[^\S\r\n]*$/gm;

export async function huntWorktree(repo: Repo, base: string, remote: string): Promise<string> {
  const path = huntPath(repo);
  const target = remoteRef(remote, base);
  await gitFetch(repo.root, [remote]);
  await git(repo.root, ['worktree', 'prune']);
  if (existsSync(join(path, '.git'))) {
    await git(path, ['checkout', '--force', '--detach', target]);
    await git(path, ['clean', '-fd']);
  } else {
    await git(repo.root, ['worktree', 'add', '--detach', path, target]);
  }
  return path;
}

function isIssueOf(repo: Repo, url: string): boolean {
  const issue = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+\/?$/i.exec(url);
  return issue?.[1]?.toLowerCase() === slug(repo).toLowerCase();
}

export async function hunt(context: Context, count: number): Promise<boolean> {
  const { repo, config, base, recorder, ports } = context;
  return recorder.step('hunt', {}, async () => {
    const cwd = await oneAtATime(repo.root, () => ports.huntWorktree(repo, base, config.remote));
    for (const label of [config.labels.ready, config.labels.hunt]) {
      if (label.length > 0) {
        await ports.ensureLabel(repo, label);
      }
    }
    const instructions = await readTextIfPresent(join(repo.root, HUNT_FILE));
    const result = await ports.runAgent(recorder, {
      name: 'hunter',
      cwd,
      prompt: huntPrompt(instructions, config.labels.ready, config.labels.hunt, count, slug(repo)),
      profile: REVIEWING,
      timeoutMs: minutesToMs(config.agentTimeoutMinutes),
    });
    const urls = [...result.text.matchAll(FILED)]
      .map((match) => match[1]!)
      .filter((url) => isIssueOf(repo, url));
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
    ready: async (running, failed) => {
      const open = (await ports.openIssues(repo, config.issueLimit, labels)).filter(
        (issue) => !failed.has(issue.number) && skipReason(issue, config, false) === undefined,
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
