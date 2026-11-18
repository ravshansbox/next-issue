import { setTimeout as delay } from 'node:timers/promises';
import { secondsToMs } from './durations.mts';
import { errorMatches } from './errors.mts';
import { must, optionalFlag, run, type RunOptions, type RunResult } from './exec.mts';
import type { Repo } from './git.mts';

const NETWORK_TRIES = 3;
const NETWORK_FAULT =
  /unexpected EOF|connection reset|connection refused|i\/o timeout|TLS handshake timeout|HTTP 50[234]/i;

export const GITHUB_HOST = 'github.com';

const realSleep = async (ms: number): Promise<void> => {
  await delay(ms);
};

let retrySleep = realSleep;

export function setRetrySleep(next = realSleep): void {
  retrySleep = next;
}

export function slug(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export function hostOf(repo: Repo): string {
  return repo.host ?? GITHUB_HOST;
}

export function repoArg(repo: Repo): string {
  return hostOf(repo) === GITHUB_HOST ? slug(repo) : `${hostOf(repo)}/${slug(repo)}`;
}

export function hostname(repo: Repo): string[] {
  return hostOf(repo) === GITHUB_HOST ? [] : ['--hostname', hostOf(repo)];
}

export async function repeatable(repo: Repo, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await must('gh', args, { cwd: repo.root });
    } catch (error) {
      if (attempt >= NETWORK_TRIES || !errorMatches(error, NETWORK_FAULT)) {
        throw error;
      }
      await retrySleep(secondsToMs(attempt));
    }
  }
}

function withRepo(repo: Repo, args: string[]): string[] {
  return [...args, '--repo', repoArg(repo)];
}

export async function gh(repo: Repo, args: string[]): Promise<string> {
  return repeatable(repo, withRepo(repo, args));
}

export async function ghJson<T>(repo: Repo, args: string[]): Promise<T> {
  return JSON.parse(await gh(repo, args)) as T;
}

export type Kind = 'issue';

export async function viewJson<T>(
  repo: Repo,
  kind: Kind,
  number: number,
  fields: string,
): Promise<T> {
  return ghJson<T>(repo, [kind, 'view', String(number), '--json', fields]);
}

export async function ghOnce(repo: Repo, args: string[], input?: string): Promise<string> {
  return must('gh', withRepo(repo, args), { cwd: repo.root, input });
}

export async function ghRun(
  repo: Repo,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return run('gh', withRepo(repo, args), { ...options, cwd: repo.root });
}

export async function ghApi(
  repo: Repo,
  path: string,
  jq: string,
  { paginate = false }: { paginate?: boolean } = {},
): Promise<string> {
  return repeatable(repo, [
    'api',
    ...hostname(repo),
    ...optionalFlag(paginate, '--paginate'),
    `repos/${slug(repo)}/${path}`,
    '--jq',
    jq,
  ]);
}

export type Named = { name: string };

export function names(items: Named[]): string[] {
  return items.map((item) => item.name);
}
