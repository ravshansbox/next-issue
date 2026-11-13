export type RunStatus = 'running' | 'stopping' | 'finished' | 'stopped' | 'failed';

export type Handled = { issue: number; outcome: 'done' | 'needs-human' | 'error' };

export type IssueProgress = {
  issue: number;
  title?: string;
  stage?: string;
  tools: number;
  lastTool?: string;
  startedAt?: number;
};

export type Progress = {
  status: RunStatus;
  issues: IssueProgress[];
  handled: Handled[];
  open?: number;
  error?: string;
};

export type Question = {
  issue: number;
  title: string;
  reason: string;
  url: string;
  repo: string;
  labels: { needsHuman: string; skip: string };
};

export type ClientMessage =
  | { type: 'hello'; version: string }
  | { type: 'start'; root: string; args?: string[] }
  | { type: 'stop'; root: string }
  | { type: 'questions'; root: string; id?: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'questions'; root: string; questions: Question[]; id?: string }
  | { type: 'questions-error'; root: string; message: string; id?: string }
  | { type: 'error'; root: string; message: string };

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
