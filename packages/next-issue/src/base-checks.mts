import { setTimeout as delay } from 'node:timers/promises';
import { type CheckState, pollChecks, type PollOptions } from './check-poll.mts';
import { secondsToMs } from './durations.mts';
import { gh, ghJson } from './gh.mts';
import type { Repo } from './git.mts';
import { runLogs } from './run-logs.mts';

type BaseRun = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  attempt: number;
};

const RESTART_TRIES = 10;

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

function failedRun(entry: BaseRun): boolean {
  return entry.status === 'completed' && FAILED_CONCLUSIONS.has(entry.conclusion);
}

function baseState(runs: BaseRun[]): CheckState {
  if (runs.some(failedRun)) {
    return 'fail';
  }
  return runs.every((entry) => entry.status === 'completed') ? 'pass' : 'pending';
}

export function waitForBaseChecks(
  repo: Repo,
  sha: string,
  options: PollOptions,
): Promise<CheckState> {
  return pollChecks(
    {
      head: async () => sha,
      lags: async () => true,
      list: async () => ((await baseRuns(repo, sha)).length === 0 ? 'none' : 'some'),
      watch: async () => baseState(await baseRuns(repo, sha)),
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
  return runLogs(repo, failed, maxChars);
}
