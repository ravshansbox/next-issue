import { setTimeout as delay } from 'node:timers/promises';
import { type CheckState, pollChecks, type PollOptions } from './check-poll.mts';
import { secondsToMs } from './durations.mts';
import { errorMatches } from './errors.mts';
import { gh, ghApi } from './gh.mts';
import type { Repo } from './git.mts';
import { runLogs } from './run-logs.mts';

type BaseRun = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  attempt: number;
  event: string;
  branch: string;
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

const ALREADY_RUNNING = /already running/i;

export type Restarted = { id: number; attempt: number };

const ACTIONS_APP = 'github-actions';

const FAILED_STATES = new Set(['failure', 'error']);

const AWAITS_APPROVAL = 'action_required';

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', AWAITS_APPROVAL]);

function jsonLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

async function baseRuns(repo: Repo, sha: string, branch: string): Promise<BaseRun[]> {
  const runs = await ghApi(
    repo,
    `actions/runs?head_sha=${sha}&per_page=100`,
    '.workflow_runs[] | {databaseId: .id, name, status, conclusion: (.conclusion // ""), attempt: .run_attempt, event, branch: (.head_branch // "")} | @json',
    { paginate: true },
  );
  return jsonLines<BaseRun>(runs).filter(
    (entry) => entry.event === 'push' && entry.branch === branch,
  );
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

async function baseChecks(
  repo: Repo,
  sha: string,
  branch: string,
  restarted: Restarted[],
): Promise<{ checks: Check[]; rerunning: boolean }> {
  const [runs, external] = await Promise.all([
    baseRuns(repo, sha, branch),
    externalChecks(repo, sha),
  ]);
  // A rerun run counts as running until a later attempt of it completes, so its old failure never ends the wait.
  const rerunning = restarted.some(
    (entry) =>
      !runs.some(
        (run) =>
          run.databaseId === entry.id && run.attempt > entry.attempt && run.status === 'completed',
      ),
  );
  return { checks: [...runs.map((entry) => ({ ...entry, url: '' })), ...external], rerunning };
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
  branch: string,
  options: PollOptions,
  restarted: Restarted[] = [],
): Promise<CheckState> {
  let read: { checks: Check[]; rerunning: boolean } = { checks: [], rerunning: false };
  return pollChecks(
    {
      head: async () => sha,
      lags: async () => true,
      list: async () => {
        read = await baseChecks(repo, sha, branch, restarted);
        return read.checks.length === 0 && !read.rerunning ? 'none' : 'some';
      },
      watch: async () => (read.rerunning ? 'pending' : baseState(read.checks)),
    },
    options,
  );
}

export async function rerunFailedBase(
  repo: Repo,
  sha: string,
  branch: string,
  started: (run: Restarted) => void = () => {},
): Promise<string[]> {
  const failed = (await baseRuns(repo, sha, branch)).filter(
    (entry) => failedRun(entry) && entry.conclusion !== AWAITS_APPROVAL,
  );
  for (const entry of failed) {
    await rerun(repo, entry.databaseId);
    started({ id: entry.databaseId, attempt: entry.attempt });
  }
  await waitForRestart(repo, sha, branch, failed);
  return failed.map((entry) => String(entry.databaseId));
}

async function rerun(repo: Repo, id: number): Promise<void> {
  try {
    await gh(repo, ['run', 'rerun', String(id), '--failed']);
  } catch (error) {
    // A rerun repeated after a lost reply finds the run running again, so that answer means the rerun started.
    if (!errorMatches(error, ALREADY_RUNNING)) {
      throw error;
    }
  }
}

async function waitForRestart(
  repo: Repo,
  sha: string,
  branch: string,
  failed: BaseRun[],
): Promise<void> {
  for (let attempt = 1; attempt <= RESTART_TRIES; attempt += 1) {
    const runs = await baseRuns(repo, sha, branch);
    const restarted = failed.every((entry) =>
      runs.some((run) => run.databaseId === entry.databaseId && run.attempt > entry.attempt),
    );
    if (restarted) {
      return;
    }
    await delay(secondsToMs(1));
  }
}

export async function failedBaseLogs(
  repo: Repo,
  sha: string,
  branch: string,
  maxChars: number,
): Promise<string> {
  const failed = (await baseRuns(repo, sha, branch))
    .filter(failedRun)
    .map((entry) => ({ heading: `## ${entry.name}`, runId: String(entry.databaseId) }));
  const external = (await externalChecks(repo, sha)).filter(failedRun).map((entry) => ({
    heading: entry.url === '' ? `## ${entry.name}` : `## ${entry.name}\n${entry.url}`,
    runId: undefined,
  }));
  return runLogs(repo, [...failed, ...external], maxChars);
}
