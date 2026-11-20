import { minutesToMs } from '../shared/durations.mts';
import type { Fields } from '../shared/observe.mts';
import type { IssueStep, Progress, RunningIssue } from '../shared/protocol.mts';

const STEPS: Record<string, IssueStep> = {
  'implement.start': 'implementing',
  'review.start': 'reviewing',
  'fix.start': 'fixing',
  'commit-fix.start': 'fixing',
  'land.start': 'landing',
  'ci-checks.start': 'waiting-for-checks',
};

export function startProgress(hunting = false): Progress {
  return { status: 'running', hunting, issues: [], looking: true };
}

export function applyEvent(progress: Progress, record: Fields): Progress {
  const kind = record['kind'];
  if (kind === 'issues.fail') {
    return { ...progress, error: String(record['error']) };
  }
  if (kind === 'watch.wait' && typeof record['minutes'] === 'number') {
    const ts = typeof record['ts'] === 'string' ? Date.parse(record['ts']) : Date.now();
    const nextLook = new Date(ts + minutesToMs(record['minutes'])).toISOString();
    return { ...progress, looking: false, nextLook };
  }
  if (kind === 'watch.wake') {
    const { nextLook: _nextLook, ...rest } = progress;
    return { ...rest, looking: true };
  }
  if (kind === 'hunt.start') {
    return { ...progress, hunt: true };
  }
  if (kind === 'hunt.end') {
    const { hunt: _hunt, ...rest } = progress;
    return rest;
  }
  const issue = record['issue'];
  if (typeof kind !== 'string' || typeof issue !== 'number') {
    return progress;
  }
  if (kind === 'issue.start') {
    return { ...progress, issues: [...withoutIssue(progress, issue), { issue }] };
  }
  if (kind === 'issue.end' || kind === 'issue.error') {
    return { ...progress, issues: withoutIssue(progress, issue) };
  }
  const step = STEPS[kind];
  if (step === undefined || !progress.issues.some((running) => running.issue === issue)) {
    return progress;
  }
  const round =
    step === 'reviewing' && typeof record['round'] === 'number' ? record['round'] : undefined;
  const entry: RunningIssue = { issue, step, ...(round === undefined ? {} : { round }) };
  return {
    ...progress,
    issues: progress.issues.map((running) => (running.issue === issue ? entry : running)),
  };
}

function withoutIssue(progress: Progress, issue: number): RunningIssue[] {
  return progress.issues.filter((running) => running.issue !== issue);
}
