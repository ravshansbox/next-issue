import { type Host, join } from './host.ts';
import { duration, outcomeNote } from './status.ts';

export type PastIssue = { issue: number; outcome: string; reason?: string };

export type RoleUse = { total: number; ms: number };

export type RunSummary = { total: number; roles: Record<string, RoleUse> };

export type PastRun = {
  id: string;
  end: 'finished' | 'stopped' | 'failed' | 'not ended';
  error?: string;
  issues: PastIssue[];
  summary?: RunSummary;
};

const KINDS = ['run.end', 'run.stop', 'run.fail', 'issues.fail', 'issue.end', 'issue.error'];
const LOG = '.jsonl';

function events(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => KINDS.some((kind) => line.includes(`"kind":"${kind}"`)))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function endOf(records: Array<Record<string, unknown>>): Pick<PastRun, 'end' | 'error'> {
  const kinds = new Set(records.map((record) => record['kind']));
  const failure = records.find(
    (record) => record['kind'] === 'run.fail' || record['kind'] === 'issues.fail',
  );
  if (failure !== undefined) {
    return { end: 'failed', error: String(failure['error']) };
  }
  if (kinds.has('run.stop')) {
    return { end: 'stopped' };
  }
  return { end: kinds.has('run.end') ? 'finished' : 'not ended' };
}

function issuesOf(records: Array<Record<string, unknown>>): PastIssue[] {
  return records.flatMap((record) => {
    if (record['kind'] === 'issue.end') {
      const reason = record['reason'];
      return [
        {
          issue: Number(record['issue']),
          outcome: String(record['outcome']),
          ...(typeof reason === 'string' ? { reason } : {}),
        },
      ];
    }
    if (record['kind'] === 'issue.error') {
      return [
        { issue: Number(record['issue']), outcome: 'error', reason: String(record['error']) },
      ];
    }
    return [];
  });
}

async function summaryOf(host: Host, file: string): Promise<RunSummary | undefined> {
  try {
    const raw = JSON.parse((await host.read(file)) ?? '') as {
      total?: { total?: number };
      roles?: Record<string, { total?: number; ms?: number }>;
    };
    return {
      total: raw.total?.total ?? 0,
      roles: Object.fromEntries(
        Object.entries(raw.roles ?? {}).map(([role, use]) => [
          role,
          { total: use.total ?? 0, ms: use.ms ?? 0 },
        ]),
      ),
    };
  } catch {
    return undefined;
  }
}

async function pastRun(host: Host, dir: string, id: string): Promise<PastRun> {
  const records = events((await host.read(join(dir, `${id}${LOG}`))) ?? '');
  const summary = await summaryOf(host, join(dir, `${id}.summary.json`));
  return {
    id,
    ...endOf(records),
    issues: issuesOf(records),
    ...(summary === undefined ? {} : { summary }),
  };
}

export async function pastRuns(host: Host, root: string): Promise<PastRun[]> {
  const dir = join(root, '.next-issue', 'runs');
  const names = await host.list(dir);
  const ids = names
    .filter((name) => name.endsWith(LOG))
    .map((name) => name.slice(0, -LOG.length))
    .sort()
    .reverse();
  return Promise.all(ids.map((id) => pastRun(host, dir, id)));
}

export function startTime(id: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  return match === null ? id : `${match[1]} ${match[2]}:${match[3]}:${match[4]} UTC`;
}

const TOKENS = new Intl.NumberFormat('en-GB');

export function runLine(run: PastRun): string {
  return `${startTime(run.id)} · ${run.end}`;
}

export function issueNote(item: PastIssue): string {
  return `#${item.issue} ${outcomeNote(item.outcome)}${item.reason === undefined ? '' : `: ${item.reason}`}`;
}

export function summaryLines(run: PastRun): string[] {
  return run.summary === undefined
    ? ['No run summary']
    : [
        `Tokens: ${TOKENS.format(run.summary.total)}`,
        ...Object.entries(run.summary.roles).map(
          ([role, use]) => `  ${role}: ${TOKENS.format(use.total)} tokens · ${duration(use.ms)}`,
        ),
      ];
}
