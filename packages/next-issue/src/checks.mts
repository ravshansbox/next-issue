import { asError, ghRun } from './gh.mts';
import { isAncestor, type Repo } from './git.mts';
import { prField } from './github.mts';
import { type Clock, type Polling, pause, REAL_CLOCK } from './poll.mts';

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

export async function runLogs(
  repo: Repo,
  failed: Array<{ heading: string; runId: string | undefined }>,
  maxChars: number,
): Promise<string> {
  const share = Math.max(1, Math.floor(maxChars / Math.max(1, failed.length)));
  const parts: string[] = [];
  for (const { heading, runId } of failed) {
    parts.push(heading);
    if (runId === undefined) {
      continue;
    }
    parts.push(await runLog(repo, runId, share));
  }
  return parts.join('\n\n');
}

async function runLog(repo: Repo, runId: string, share: number): Promise<string> {
  const logs = await ghRun(repo, ['run', 'view', runId, '--log-failed'], { tailChars: share });
  if (logs.code === 0) {
    return logs.stdout;
  }
  const reason = joinFilled(
    [`The log read failed with code ${logs.code}.`, logs.stderr.trim()],
    ' ',
  );
  return joinFilled([logs.stdout.trim(), reason], '\n');
}

function joinFilled(parts: string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator);
}
