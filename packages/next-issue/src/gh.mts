import { setTimeout as delay } from 'node:timers/promises';
import { secondsToMs } from './durations.mts';
import { errorMatches } from './errors.mts';
import { must, optionalFlag, run, type RunOptions, type RunResult } from './exec.mts';
import type { Repo } from './git.mts';

const NETWORK_TRIES = 3;
const NETWORK_FAULT =
  /unexpected EOF|connection reset|connection refused|i\/o timeout|TLS handshake timeout|HTTP 50[234]/i;

export function slug(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export async function repeatable(repo: Repo, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await must('gh', args, { cwd: repo.root });
    } catch (error) {
      if (attempt >= NETWORK_TRIES || !errorMatches(error, NETWORK_FAULT)) {
        throw error;
      }
      await delay(secondsToMs(attempt));
    }
  }
}

function withRepo(repo: Repo, args: string[]): string[] {
  return [...args, '--repo', slug(repo)];
}

export async function gh(repo: Repo, args: string[]): Promise<string> {
  return repeatable(repo, withRepo(repo, args));
}

export async function ghJson<T>(repo: Repo, args: string[]): Promise<T> {
  return JSON.parse(await gh(repo, args)) as T;
}

export type Kind = 'issue' | 'pr';

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
    ...optionalFlag(paginate, '--paginate'),
    `repos/${slug(repo)}/${path}`,
    '--jq',
    jq,
  ]);
}

export async function ghSucceeds(repo: Repo, args: string[]): Promise<boolean> {
  const result = await ghRun(repo, args);
  return result.code === 0;
}

export type Named = { name: string };

export function names(items: Named[]): string[] {
  return items.map((item) => item.name);
}
