import { type CheckState, pollChecks, type PollOptions } from './check-poll.mts';
import { failedWith, succeeded } from './exec.mts';
import { ghRun } from './gh.mts';
import { isAncestor, type Repo } from './git.mts';
import { prField } from './pull-requests.mts';
import { runLogs } from './run-logs.mts';

const CHECK_PENDING_CODE = 8;
const NO_CHECKS = /no checks reported/i;

type CheckSummary = { name: string; bucket: string; link: string; description: string };

function failedCheck(check: CheckSummary): boolean {
  return check.bucket === 'fail';
}

async function readChecks(repo: Repo, pr: number): Promise<CheckSummary[] | 'none'> {
  const result = await ghRun(repo, [
    'pr',
    'checks',
    String(pr),
    '--json',
    'name,bucket,link,description',
  ]);
  const output = result.stdout.trim();
  if (output.length === 0) {
    if (NO_CHECKS.test(result.stderr)) {
      return 'none';
    }
    throw new Error(failedWith(`gh pr checks ${pr}`, result));
  }
  const checks = JSON.parse(output) as CheckSummary[];
  return checks.length === 0 ? 'none' : checks;
}

async function watchOnce(
  repo: Repo,
  pr: number,
  intervalSeconds: number,
  timeoutMs: number,
  show: boolean,
): Promise<CheckState> {
  const watch = await ghRun(
    repo,
    ['pr', 'checks', String(pr), '--watch', '--fail-fast', '--interval', String(intervalSeconds)],
    { show, timeoutMs },
  );
  if (watch.timedOut) {
    return 'timeout';
  }
  if (succeeded(watch)) {
    return 'pass';
  }
  if (watch.code === CHECK_PENDING_CODE) {
    return 'pending';
  }
  const checks = await readChecks(repo, pr);
  if (checks !== 'none' && checks.some(failedCheck)) {
    return 'fail';
  }
  throw new Error(
    `gh pr checks ${pr} --watch failed with code ${watch.code} and no check failed: ${watch.stderr.trim()}`,
  );
}

export type WaitOptions = PollOptions & { show: boolean };

export function waitForChecks(repo: Repo, pr: number, options: WaitOptions): Promise<CheckState> {
  return pollChecks(
    {
      head: () => prField(repo, pr, 'headRefOid'),
      lags: (head) =>
        options.head === undefined
          ? Promise.resolve(true)
          : isAncestor(repo.root, head, options.head),
      list: async () => ((await readChecks(repo, pr)) === 'none' ? 'none' : 'some'),
      watch: (timeoutMs) => watchOnce(repo, pr, options.intervalSeconds, timeoutMs, options.show),
    },
    options,
  );
}

export async function failedCheckLogs(repo: Repo, pr: number, maxChars: number): Promise<string> {
  const checks = await readChecks(repo, pr);
  if (checks === 'none') {
    return 'The checks failed, but gh reports no check for the pull request.';
  }
  const failed = checks.filter(failedCheck).map((check) => ({
    heading: `## ${check.name}\n${check.description}`,
    runId: /\/actions\/runs\/(\d+)/.exec(check.link)?.[1],
  }));
  return runLogs(repo, failed, maxChars);
}
