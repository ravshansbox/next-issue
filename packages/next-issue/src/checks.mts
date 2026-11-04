import { asError, ghRun } from './gh.mts';
import { isAncestor, type Repo } from './git.mts';
import { prField } from './pull-requests.mts';
import { type Clock, type Polling, pause, REAL_CLOCK } from './poll.mts';
import { runLogs } from './run-logs.mts';

export type CheckState = 'pass' | 'fail' | 'pending' | 'none' | 'timeout' | 'moved';

const CHECK_PENDING_CODE = 8;
const READ_TRIES = 3;
const NO_CHECKS = /no checks reported/i;

type CheckSummary = { name: string; bucket: string; link: string; description: string };

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
    throw new Error(`gh pr checks ${pr} failed with code ${result.code}: ${result.stderr.trim()}`);
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
  if (watch.code === 0) {
    return 'pass';
  }
  if (watch.code === CHECK_PENDING_CODE) {
    return 'pending';
  }
  const checks = await readChecks(repo, pr);
  if (checks !== 'none' && checks.some((check) => check.bucket === 'fail')) {
    return 'fail';
  }
  throw new Error(
    `gh pr checks ${pr} --watch failed with code ${watch.code} and no check failed: ${watch.stderr.trim()}`,
  );
}

export type ChecksProbe = {
  head: () => Promise<string>;
  lags: (head: string) => Promise<boolean>;
  list: () => Promise<'none' | 'some'>;
  watch: (timeoutMs: number) => Promise<CheckState>;
};

export type PollOptions = Polling & {
  graceMs: number;
  head?: string;
};

export type WaitOptions = PollOptions & { show: boolean };

export async function pollChecks(
  probe: ChecksProbe,
  options: PollOptions,
  clock: Clock = REAL_CLOCK,
): Promise<CheckState> {
  const deadline = clock.now() + options.timeoutMs;
  const rest = (): number => Math.max(0, deadline - clock.now());
  let shown: number | undefined;
  let failures = 0;
  for (;;) {
    if (rest() === 0) {
      return 'timeout';
    }
    const state = await read(probe, options.head, rest(), () => (shown ??= clock.now()));
    if (state === 'behind' && shown !== undefined) {
      return 'moved';
    }
    if (state instanceof Error) {
      failures += 1;
      if (failures >= READ_TRIES) {
        throw state;
      }
    } else {
      failures = 0;
      const outcome = settled(state, clock.now() - (shown ?? 0), options.graceMs);
      if (outcome !== undefined) {
        return outcome;
      }
    }
    await pause(clock, options, rest());
  }
}

function settled(
  state: CheckState | 'behind',
  waitedMs: number,
  graceMs: number,
): CheckState | undefined {
  if (state === 'none') {
    return waitedMs >= graceMs ? 'none' : undefined;
  }
  return state === 'behind' || state === 'pending' ? undefined : state;
}

async function read(
  probe: ChecksProbe,
  head: string | undefined,
  timeoutMs: number,
  shown: () => void,
): Promise<CheckState | 'none' | 'behind' | Error> {
  try {
    if (head !== undefined) {
      const current = await probe.head();
      if (current !== head) {
        return (await probe.lags(current)) ? 'behind' : 'moved';
      }
    }
    shown();
    if ((await probe.list()) === 'none') {
      return 'none';
    }
    const state = await probe.watch(timeoutMs);
    if (head !== undefined && (await probe.head()) !== head) {
      return 'moved';
    }
    return state;
  } catch (error) {
    return asError(error);
  }
}

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
  const failed = checks
    .filter((check) => check.bucket === 'fail')
    .map((check) => ({
      heading: `## ${check.name}\n${check.description}`,
      runId: /\/actions\/runs\/(\d+)/.exec(check.link)?.[1],
    }));
  return runLogs(repo, failed, maxChars);
}
