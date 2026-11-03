import type { Fields } from './observe.mts';

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

const TOOL_LINE_MAX = 80;

const NOT_STAGES = new Set(['issue.start', 'agent.start', 'run.start']);

export function startProgress(): Progress {
  return { status: 'running', tools: 0, handled: [] };
}

function idle(progress: Progress): Progress {
  const {
    issue: _issue,
    title: _title,
    stage: _stage,
    lastTool: _lastTool,
    issueStartedAt: _at,
    ...rest
  } = progress;
  return { ...rest, tools: 0 };
}

function toolLine(record: Fields): string {
  const tool = String(record['tool']);
  const command = record['command'];
  const line = typeof command === 'string' ? `${tool} ${command.split('\n')[0]}` : tool;
  return line.length > TOOL_LINE_MAX ? `${line.slice(0, TOOL_LINE_MAX - 1)}…` : line;
}

export function applyEvent(progress: Progress, record: Fields): Progress {
  const kind = String(record['kind']);
  if (kind === 'issue.start') {
    const next: Progress = {
      ...idle(progress),
      issue: Number(record['issue']),
      issueStartedAt: Date.parse(String(record['ts'])),
    };
    if (typeof record['title'] === 'string') {
      next.title = record['title'];
    }
    return next;
  }
  if (kind === 'tool') {
    return { ...progress, tools: progress.tools + 1, lastTool: toolLine(record) };
  }
  if (kind === 'issue.end' || kind === 'issue.error') {
    const outcome = kind === 'issue.error' ? 'error' : record['outcome'];
    const handled: Handled[] =
      outcome === 'done' || outcome === 'needs-human' || outcome === 'error'
        ? [...progress.handled, { issue: Number(record['issue']), outcome }]
        : progress.handled;
    return { ...idle(progress), handled };
  }
  if (kind === 'issues.fail') {
    return { ...progress, error: String(record['error']) };
  }
  if (kind.endsWith('.start') && !NOT_STAGES.has(kind) && progress.issue !== undefined) {
    const stage = kind.slice(0, -'.start'.length);
    const round = record['round'];
    return { ...progress, stage: typeof round === 'number' ? `${stage} ${round}` : stage };
  }
  return progress;
}
