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

export type Question = { issue: number; title: string; reason: string; url: string };

export type ClientMessage =
  | { type: 'hello'; version: string }
  | { type: 'start'; root: string; merge: boolean }
  | { type: 'stop'; root: string }
  | { type: 'questions'; root: string };

export type WorkerMessage =
  | { type: 'hello'; version: string }
  | { type: 'runs'; runs: Record<string, Progress> }
  | { type: 'questions'; root: string; questions: Question[] }
  | { type: 'error'; root: string; message: string };

export function isNewer(candidate: string, current: string): boolean {
  const [leftCore = '', ...leftRest] = candidate.replace(/\+.*$/, '').split('-');
  const [rightCore = '', ...rightRest] = current.replace(/\+.*$/, '').split('-');
  const left = leftCore.split('.').map(Number);
  const right = rightCore.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  const leftPrerelease = leftRest.length > 0 ? leftRest.join('-').split('.') : [];
  const rightPrerelease = rightRest.length > 0 ? rightRest.join('-').split('.') : [];
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    return leftPrerelease.length === 0 && rightPrerelease.length > 0;
  }
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
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
