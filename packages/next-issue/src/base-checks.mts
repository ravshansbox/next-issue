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
  jobs?: Job[];
};

type Job = { databaseId: number; name: string; status: string; conclusion: string };

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

async function baseRuns(
  repo: Repo,
  sha: string,
  branch: string,
  ignored: string[],
): Promise<BaseRun[]> {
  const runs = await ghApi(
    repo,
    `actions/runs?head_sha=${sha}&per_page=100`,
    '.workflow_runs[] | {databaseId: .id, name, status, conclusion: (.conclusion // ""), attempt: .run_attempt, event, branch: (.head_branch // "")} | @json',
    { paginate: true },
  );
  const pushed = jsonLines<BaseRun>(runs).filter(
    (entry) => entry.event === 'push' && entry.branch === branch,
  );
  if (ignored.length === 0) {
    return pushed;
  }
  const judged = await Promise.all(pushed.map((entry) => withoutIgnored(repo, entry, ignored)));
  return judged.filter((entry) => entry !== undefined);
}

/** Judges a workflow run by its jobs outside the ignored checks; a run with no job yet, or a running one whose listed jobs all finished, keeps its own state, as a job not listed yet may follow. A running one whose kept jobs failed waits until it finishes, as GitHub refuses to rerun a running run. */
async function withoutIgnored(
  repo: Repo,
  run: BaseRun,
  ignored: string[],
): Promise<BaseRun | undefined> {
  const jobs = jsonLines<Job>(
    await ghApi(
      repo,
      `actions/runs/${run.databaseId}/jobs?filter=latest&per_page=100`,
      '.jobs[] | {databaseId: .id, name, status, conclusion: (.conclusion // "")} | @json',
      { paginate: true },
    ),
  );
  if (jobs.length === 0 || (run.status !== 'completed' && jobs.every(completedJob))) {
    return run;
  }
  const kept = jobs.filter((job) => !ignored.includes(job.name));
  if (kept.length === 0) {
    return undefined;
  }
  if (!kept.every(completedJob)) {
    return { ...run, status: 'in_progress', conclusion: '', jobs: kept };
  }
  const judged = { ...run, status: 'completed', conclusion: jobsConclusion(kept), jobs: kept };
  if (run.status !== 'completed' && rerunnable(judged)) {
    return { ...run, status: 'in_progress', conclusion: '', jobs: kept };
  }
  return judged;
}

function completedJob(job: Job): boolean {
  return job.status === 'completed';
}

function jobsConclusion(jobs: Job[]): string {
  if (jobs.some(failedRun)) {
    return 'failure';
  }
  return jobs.some((job) => job.conclusion === 'cancelled') ? 'cancelled' : 'success';
}

async function externalChecks(repo: Repo, sha: string, ignored: string[]): Promise<Check[]> {
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
  return [...checkRuns, ...commitStatuses].filter((entry) => !ignored.includes(entry.name));
}

async function baseChecks(
  repo: Repo,
  sha: string,
  branch: string,
  restarted: Restarted[],
  ignored: string[],
): Promise<{ runs: BaseRun[]; external: Check[]; rerunning: boolean }> {
  const [runs, external] = await Promise.all([
    baseRuns(repo, sha, branch, ignored),
    externalChecks(repo, sha, ignored),
  ]);
  // A rerun run counts as running until a later attempt of it completes, so its old failure never ends the wait.
  const rerunning = restarted.some(
    (entry) =>
      !runs.some(
        (run) =>
          run.databaseId === entry.id && run.attempt > entry.attempt && run.status === 'completed',
      ),
  );
  return { runs, external, rerunning };
}

function failedRun(entry: { status: string; conclusion: string }): boolean {
  return entry.status === 'completed' && FAILED_CONCLUSIONS.has(entry.conclusion);
}

/** A failed workflow run whose failed jobs were not rerun yet; one that waits for approval cannot be rerun. */
function rerunnable(entry: BaseRun): boolean {
  return failedRun(entry) && entry.conclusion !== AWAITS_APPROVAL && !(entry.attempt > 1);
}

function baseState(runs: BaseRun[], external: Check[]): CheckState {
  // A failure that gets a rerun ends the wait at once; any other failure waits for every check, so no run that fails later misses its rerun.
  if (runs.some(rerunnable)) {
    return 'fail';
  }
  const checks = [...runs, ...external];
  if (!checks.every((entry) => entry.status === 'completed')) {
    return 'pending';
  }
  if (checks.some(failedRun)) {
    return 'fail';
  }
  return checks.some((entry) => entry.conclusion === 'cancelled') ? 'cancelled' : 'pass';
}

export function waitForBaseChecks(
  repo: Repo,
  sha: string,
  branch: string,
  options: PollOptions,
  restarted: Restarted[] = [],
  ignored: string[] = [],
): Promise<CheckState> {
  let read: { runs: BaseRun[]; external: Check[]; rerunning: boolean } = {
    runs: [],
    external: [],
    rerunning: false,
  };
  return pollChecks(
    {
      head: async () => sha,
      lags: async () => true,
      list: async () => {
        read = await baseChecks(repo, sha, branch, restarted, ignored);
        return read.runs.length + read.external.length === 0 && !read.rerunning ? 'none' : 'some';
      },
      watch: async () => (read.rerunning ? 'pending' : baseState(read.runs, read.external)),
    },
    options,
  );
}

export async function rerunFailedBase(
  repo: Repo,
  sha: string,
  branch: string,
  started: (run: Restarted) => void = () => {},
  ignored: string[] = [],
): Promise<string[]> {
  const failed = (await baseRuns(repo, sha, branch, ignored)).filter(rerunnable);
  for (const entry of failed) {
    await rerun(repo, entry.databaseId);
    started({ id: entry.databaseId, attempt: entry.attempt });
  }
  if (failed.length > 0) {
    await waitForRestart(repo, sha, branch, failed, ignored);
  }
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
  ignored: string[],
): Promise<void> {
  for (let attempt = 1; attempt <= RESTART_TRIES; attempt += 1) {
    const runs = await baseRuns(repo, sha, branch, ignored);
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
  ignored: string[] = [],
): Promise<string> {
  const failed = (await baseRuns(repo, sha, branch, ignored)).filter(failedRun).flatMap((entry) =>
    entry.jobs === undefined
      ? [{ heading: `## ${entry.name}`, view: [String(entry.databaseId)] }]
      : entry.jobs.filter(failedRun).map((job) => ({
          heading: `## ${entry.name} / ${job.name}`,
          view: ['--job', String(job.databaseId)],
        })),
  );
  const external = (await externalChecks(repo, sha, ignored)).filter(failedRun).map((entry) => ({
    heading: entry.url === '' ? `## ${entry.name}` : `## ${entry.name}\n${entry.url}`,
    view: undefined,
  }));
  return runLogs(repo, [...failed, ...external], maxChars);
}
