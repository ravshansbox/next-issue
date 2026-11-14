import { setTimeout as delay } from 'node:timers/promises';
import { type CheckState, pollChecks, type PollOptions } from './check-poll.mts';
import { secondsToMs } from './durations.mts';
import { gh, ghApi, ghJson } from './gh.mts';
import type { Repo } from './git.mts';
import { runLogs } from './run-logs.mts';

type BaseRun = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  attempt: number;
};

type Check = { name: string; status: string; conclusion: string; url: string };

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  app: string;
  url: string | null;
};

type CommitStatus = { name: string; state: string; url: string | null };

const RESTART_TRIES = 10;

const ACTIONS_APP = 'github-actions';

const FAILED_STATES = new Set(['failure', 'error']);

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

async function baseRuns(repo: Repo, sha: string): Promise<BaseRun[]> {
  return ghJson<BaseRun[]>(repo, [
    'run',
    'list',
    '--commit',
    sha,
    '--json',
    'databaseId,name,status,conclusion,attempt',
  ]);
}

function jsonLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

async function externalChecks(repo: Repo, sha: string): Promise<Check[]> {
  const [runs, statuses] = await Promise.all([
    ghApi(
      repo,
      `commits/${sha}/check-runs?per_page=100`,
      '.check_runs[] | {name, status, conclusion, app: .app.slug, url: .details_url} | @json',
      { paginate: true },
    ),
    ghApi(
      repo,
      `commits/${sha}/status?per_page=100`,
      '.statuses[] | {name: .context, state, url: .target_url} | @json',
      { paginate: true },
    ),
  ]);
  const checkRuns = jsonLines<CheckRun>(runs)
    .filter((entry) => entry.app !== ACTIONS_APP)
    .map((entry) => ({
      name: entry.name,
      status: entry.status,
      conclusion: entry.conclusion === 'action_required' ? 'failure' : (entry.conclusion ?? ''),
      url: entry.url ?? '',
    }));
  const commitStatuses = jsonLines<CommitStatus>(statuses).map((entry) => ({
    name: entry.name,
    status: entry.state === 'pending' ? 'pending' : 'completed',
    conclusion: FAILED_STATES.has(entry.state) ? 'failure' : entry.state,
    url: entry.url ?? '',
  }));
  return [...checkRuns, ...commitStatuses];
}

async function baseChecks(repo: Repo, sha: string): Promise<Check[]> {
  const [runs, external] = await Promise.all([baseRuns(repo, sha), externalChecks(repo, sha)]);
  return [...runs.map((entry) => ({ ...entry, url: '' })), ...external];
}

function failedRun(entry: { status: string; conclusion: string }): boolean {
  return entry.status === 'completed' && FAILED_CONCLUSIONS.has(entry.conclusion);
}

function baseState(runs: Check[]): CheckState {
  if (runs.some(failedRun)) {
    return 'fail';
  }
  if (!runs.every((entry) => entry.status === 'completed')) {
    return 'pending';
  }
  return runs.some((entry) => entry.conclusion === 'cancelled') ? 'cancelled' : 'pass';
}

export function waitForBaseChecks(
  repo: Repo,
  sha: string,
  options: PollOptions,
): Promise<CheckState> {
  let checks: Check[] = [];
  return pollChecks(
    {
      head: async () => sha,
      lags: async () => true,
      list: async () => {
        checks = await baseChecks(repo, sha);
        return checks.length === 0 ? 'none' : 'some';
      },
      watch: async () => baseState(checks),
    },
    options,
  );
}

export async function rerunFailedBase(repo: Repo, sha: string): Promise<string[]> {
  const failed = (await baseRuns(repo, sha)).filter(failedRun);
  for (const entry of failed) {
    await gh(repo, ['run', 'rerun', String(entry.databaseId), '--failed']);
  }
  await waitForRestart(repo, sha, failed);
  return failed.map((entry) => String(entry.databaseId));
}

async function waitForRestart(repo: Repo, sha: string, failed: BaseRun[]): Promise<void> {
  for (let attempt = 1; attempt <= RESTART_TRIES; attempt += 1) {
    const runs = await baseRuns(repo, sha);
    const restarted = failed.every((entry) =>
      runs.some((run) => run.databaseId === entry.databaseId && run.attempt > entry.attempt),
    );
    if (restarted) {
      return;
    }
    await delay(secondsToMs(1));
  }
}

export async function failedBaseLogs(repo: Repo, sha: string, maxChars: number): Promise<string> {
  const failed = (await baseRuns(repo, sha))
    .filter(failedRun)
    .map((entry) => ({ heading: `## ${entry.name}`, runId: String(entry.databaseId) }));
  const external = (await externalChecks(repo, sha)).filter(failedRun).map((entry) => ({
    heading: entry.url === '' ? `## ${entry.name}` : `## ${entry.name}\n${entry.url}`,
    runId: undefined,
  }));
  return runLogs(repo, [...failed, ...external], maxChars);
}
