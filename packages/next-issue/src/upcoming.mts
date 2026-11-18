import { type Config, loadConfig } from './config.mts';
import { message } from './errors.mts';
import { detectRepo, type Repo } from './git.mts';
import { type Ports, PORTS } from './ports.mts';
import type { Upcoming } from './protocol.mts';
import { type Peer, send } from './questions.mts';
import { listedIssues, skipReason } from './skip.mts';
import { savedIssues } from './state.mts';

export type ListUpcoming = (root: string) => Promise<Upcoming>;

/** The fresh issues the worker would claim, oldest first as it claims them; issues with saved state resume instead. */
export async function upcomingIssues(
  repo: Repo,
  config: Config,
  ports: Pick<Ports, 'openIssues' | 'openBlockers'>,
): Promise<Upcoming> {
  const issues = await listedIssues(ports, repo, config, []);
  const saved = new Set(await savedIssues(repo));
  const upcoming: Upcoming = { claimable: [], blocked: [] };
  for (const issue of issues) {
    if (saved.has(issue.number) || skipReason(issue, config, false) !== undefined) {
      continue;
    }
    const blockers = await ports.openBlockers(repo, issue.number);
    const item = { issue: issue.number, title: issue.title };
    if (blockers.length > 0) {
      upcoming.blocked.push({ ...item, blockers });
    } else {
      upcoming.claimable.push(item);
    }
  }
  return upcoming;
}

export async function listUpcoming(root: string): Promise<Upcoming> {
  const config = await loadConfig(root);
  return upcomingIssues(await detectRepo(root, config.remote), config, PORTS);
}

export async function sendUpcoming(list: ListUpcoming, socket: Peer, root: string): Promise<void> {
  try {
    send(socket, { type: 'upcoming', root, ...(await list(root)) });
  } catch (error) {
    send(socket, { type: 'upcoming-error', root, message: message(error) });
  }
}
