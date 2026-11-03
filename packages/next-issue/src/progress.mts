import type { Fields } from './observe.mts';
import type { Handled, IssueProgress, Progress } from './protocol.mts';

const TOOL_LINE_MAX = 80;

const NOT_STAGES = new Set(['issue.start', 'agent.start', 'run.start']);

export function startProgress(): Progress {
  return { status: 'running', issues: [], handled: [] };
}

function toolLine(record: Fields): string {
  const tool = String(record['tool']);
  const command = record['command'];
  const line = typeof command === 'string' ? `${tool} ${command.split('\n')[0]}` : tool;
  return line.length > TOOL_LINE_MAX ? `${line.slice(0, TOOL_LINE_MAX - 1)}…` : line;
}

function stageName(step: string, record: Fields): string {
  const cause = record['cause'];
  if (step === 'fix' && typeof cause === 'string') {
    return `${cause} fix`;
  }
  if (step === 'commit-fix') {
    return 'commit fix';
  }
  return step;
}

function stageOf(step: string, record: Fields): string {
  const name = stageName(step, record);
  const round = record['round'];
  const limit = record['limit'];
  if (typeof round !== 'number') {
    return name;
  }
  return typeof limit === 'number' ? `${name} ${round}/${limit}` : `${name} ${round}`;
}

function without(issues: IssueProgress[], issue: number): IssueProgress[] {
  return issues.filter((current) => current.issue !== issue);
}

function change(
  progress: Progress,
  issue: number,
  update: (current: IssueProgress) => IssueProgress,
): Progress {
  return {
    ...progress,
    issues: progress.issues.map((current) => (current.issue === issue ? update(current) : current)),
  };
}

export function applyEvent(progress: Progress, record: Fields): Progress {
  const kind = String(record['kind']);
  const issue = Number(record['issue']);
  if (kind === 'issue.start') {
    const next: IssueProgress = {
      issue,
      tools: 0,
      startedAt: Date.parse(String(record['ts'])),
    };
    if (typeof record['title'] === 'string') {
      next.title = record['title'];
    }
    return { ...progress, issues: [...without(progress.issues, issue), next] };
  }
  if (kind === 'tool') {
    return change(progress, issue, (current) => ({
      ...current,
      tools: current.tools + 1,
      lastTool: toolLine(record),
    }));
  }
  if (kind === 'issue.end' || kind === 'issue.error') {
    const outcome = kind === 'issue.error' ? 'error' : record['outcome'];
    const repeated = progress.handled.some(
      (item) => item.issue === issue && item.outcome === outcome,
    );
    const handled: Handled[] =
      !repeated && (outcome === 'done' || outcome === 'needs-human' || outcome === 'error')
        ? [...progress.handled, { issue, outcome }]
        : progress.handled;
    return { ...progress, issues: without(progress.issues, issue), handled };
  }
  if (kind === 'issues') {
    return { ...progress, open: Number(record['open']) };
  }
  if (kind === 'issues.fail') {
    return { ...progress, error: String(record['error']) };
  }
  if (kind.endsWith('.start') && !NOT_STAGES.has(kind)) {
    const stage = stageOf(kind.slice(0, -'.start'.length), record);
    return change(progress, issue, (current) => ({ ...current, stage }));
  }
  return progress;
}
