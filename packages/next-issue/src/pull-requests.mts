import { gh, ghJson, ghOnce, ghSucceeds } from './gh.mts';
import type { Repo } from './git.mts';
import { type Clock, type Polling, pollUntil, REAL_CLOCK } from './poll.mts';

export async function findPr(repo: Repo, branch: string): Promise<number | undefined> {
  const parsed = await ghJson<Array<{ number: number }>>(repo, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  return parsed[0]?.number;
}

export async function createPr(
  repo: Repo,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<number> {
  const created = await ghOnce(repo, [
    'pr',
    'create',
    '--head',
    branch,
    '--base',
    base,
    '--title',
    title,
    '--body',
    body,
    ...(draft ? ['--draft'] : []),
  ]);
  const number = prNumber(created) ?? (await findPr(repo, branch));
  if (number === undefined) {
    throw new Error(`The pull request for ${branch} was not found after creation.`);
  }
  return number;
}

export function prNumber(output: string): number | undefined {
  const match = /\/pull\/(\d+)\b/.exec(output);
  return match === null ? undefined : Number(match[1]);
}

export async function prField(repo: Repo, pr: number, field: string): Promise<string> {
  return gh(repo, ['pr', 'view', String(pr), '--json', field, '--jq', `.${field}`]);
}

export async function markPrReady(repo: Repo, pr: number): Promise<boolean> {
  return ghSucceeds(repo, ['pr', 'ready', String(pr)]);
}

export async function mergePr(repo: Repo, pr: number): Promise<boolean> {
  return ghSucceeds(repo, ['pr', 'merge', String(pr), '--squash', '--delete-branch']);
}

export async function prConflicts(
  repo: Repo,
  pr: number,
  options: Polling,
  clock: Clock = REAL_CLOCK,
): Promise<boolean> {
  const mergeable = await pollUntil(
    options,
    clock,
    () => prField(repo, pr, 'mergeable'),
    (value) => value !== 'UNKNOWN',
  );
  return mergeable === 'CONFLICTING';
}

export async function prMerged(repo: Repo, pr: number): Promise<boolean> {
  return (await prField(repo, pr, 'state')) === 'MERGED';
}

export async function mergeCommit(
  repo: Repo,
  pr: number,
  options: Polling,
  clock: Clock = REAL_CLOCK,
): Promise<string | undefined> {
  const view = await pollUntil(
    options,
    clock,
    () =>
      ghJson<{ state: string; mergeCommit: { oid: string } | null }>(repo, [
        'pr',
        'view',
        String(pr),
        '--json',
        'state,mergeCommit',
      ]),
    (value) => (value.state === 'MERGED' && !!value.mergeCommit?.oid) || value.state === 'CLOSED',
  );
  return (view.state === 'MERGED' && view.mergeCommit?.oid) || undefined;
}
