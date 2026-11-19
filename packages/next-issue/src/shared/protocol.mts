export type RunStatus = 'running' | 'stopping' | 'finished' | 'stopped' | 'failed';

export type Upgrade = { from: string; to: string; resumes?: boolean };

export type Launch = { command: string; args: string[] };

export type IssueStep = 'implementing' | 'reviewing' | 'fixing' | 'landing' | 'waiting-for-checks';

export type RunningIssue = { issue: number; step?: IssueStep; round?: number };

export type Progress = {
  status: RunStatus;
  issues: RunningIssue[];
  hunting: boolean;
  watching?: boolean;
  upgrade?: Upgrade;
  error?: string;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type RunSummary = {
  runId: string;
  logFile: string;
  roles: Record<string, Usage & { calls: number; ms: number }>;
  counts: Record<string, number>;
  total: Usage;
  issues: {
    issue: number;
    outcome: 'done' | 'needs-human' | 'skipped' | 'error' | 'stopped';
    reason?: string;
    ciFixes: number;
    reviewRounds: number;
    ms: number;
    halt?: boolean;
    handedOver?: boolean;
    blocked?: boolean;
  }[];
};

export const STOP_POINTS = ['issue', 'round', 'now'] as const;

export type StopPoint = (typeof STOP_POINTS)[number];

export type ClientMessage =
  | { type: 'hello'; version: string; launch?: Launch }
  | {
      type: 'start';
      root: string;
      args?: string[];
      resume?: boolean;
      id?: string;
    }
  | { type: 'stop'; root: string; after?: StopPoint; id?: string }
  | { type: 'hunt'; root: string; on: boolean; id?: string }
  | { type: 'watch'; root: string; on: boolean; id?: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress>; id?: string }
  | { type: 'output'; root: string; text: string }
  | { type: 'end'; root: string; code: number; summary?: RunSummary; error?: string }
  | { type: 'pass'; root: string; summary: RunSummary }
  | { type: 'stopping'; root: string; waiting: boolean; hunting: boolean; id?: string }
  | { type: 'error'; root: string; message: string; id?: string };

export function isNewer(candidate: string, current: string): boolean {
  const { core: left, prerelease: leftPrerelease } = parseVersion(candidate);
  const { core: right, prerelease: rightPrerelease } = parseVersion(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return isNewerPrerelease(leftPrerelease, rightPrerelease);
}

function isNewerPrerelease(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return left.length === 0 && right.length > 0;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return rightPart === undefined;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart);
    }
    if (leftNumeric || rightNumeric) {
      return rightNumeric;
    }
    return leftPart > rightPart;
  }
  return false;
}

function parseVersion(version: string): { core: number[]; prerelease: string[] } {
  const [core = '', ...rest] = version.replace(/\+.*$/, '').split('-');
  return {
    core: core.split('.').map(Number),
    prerelease: rest.length > 0 ? rest.join('-').split('.') : [],
  };
}
