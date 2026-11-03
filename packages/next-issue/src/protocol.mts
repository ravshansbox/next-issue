export type RunStatus = 'running' | 'stopping' | 'finished' | 'stopped' | 'failed';

export type Handled = { issue: number; outcome: 'done' | 'needs-human' | 'error' };

export type Progress = {
  status: RunStatus;
  issue?: number;
  title?: string;
  stage?: string;
  tools: number;
  lastTool?: string;
  issueStartedAt?: number;
  handled: Handled[];
  error?: string;
};

export type ClientMessage =
  | { type: 'hello'; version: string }
  | { type: 'start'; root: string; merge: boolean }
  | { type: 'stop'; root: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'error'; root: string; message: string };

function parseVersion(version: string): { core: number[]; prerelease: string[] } {
  const plain = version.split('+')[0] ?? '';
  const dash = plain.indexOf('-');
  const core = dash === -1 ? plain : plain.slice(0, dash);
  const prerelease = dash === -1 ? [] : plain.slice(dash + 1).split('.');
  return { core: core.split('.').map(Number), prerelease };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === 0 && right.prerelease.length > 0;
  }
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return rightPart === undefined;
    }
    const difference = compareIdentifiers(leftPart, rightPart);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}
