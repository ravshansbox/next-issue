import { type Host, join } from './host.ts';
import { startTime } from './past.ts';

type Entry = Record<string, unknown>;
type Block = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};
type Message = {
  type?: string;
  subtype?: string;
  cwd?: string;
  message?: { content?: string | Block[] };
};

const LOG = '.jsonl';
const HIDDEN = new Set(['ts', 'runId', 'kind', 'issue']);
const TOOL_FIELDS: Record<string, string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern', 'path'],
  Glob: ['pattern', 'path'],
};
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path']);

function parsed(text: string): Entry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === 'object' && value !== null ? [value as Entry] : [];
    } catch {
      return [];
    }
  });
}

function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function eventLine(event: Entry): string {
  const time = typeof event['ts'] === 'string' ? event['ts'].slice(11, 19) : '';
  const fields = Object.entries(event)
    .filter(([key]) => !HIDDEN.has(key))
    .map(([key, value]) => `${key}=${shown(value)}`);
  return [time, String(event['kind']), ...fields].join(' ');
}

function labelled(label: string, text: string): string[] {
  return `${label}: ${text}`.split('\n');
}

function shortPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined) {
    return path;
  }
  if (path === cwd) {
    return '.';
  }
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function toolLine(item: Block, cwd: string | undefined): string {
  const name = item.name ?? '';
  const values = (TOOL_FIELDS[name] ?? []).flatMap((field) => {
    const value = item.input?.[field];
    if (typeof value !== 'string') {
      return [];
    }
    return [PATH_FIELDS.has(field) ? shortPath(value, cwd) : value.replaceAll('\n', ' ')];
  });
  return ['tool', name, ...values].join(' ');
}

function messageLines(record: Message, cwd: string | undefined): string[] {
  const role = record.type;
  if (role !== 'user' && role !== 'assistant') {
    return [];
  }
  const content = record.message?.content;
  if (typeof content === 'string') {
    return labelled(role, content);
  }
  return (content ?? []).flatMap((item) => {
    if (item.type === 'thinking') {
      return ['thinking'];
    }
    if (item.type === 'tool_use') {
      return [toolLine(item, cwd)];
    }
    return item.type === 'text' ? labelled(role, item.text ?? '') : [];
  });
}

async function sessionLines(host: Host, dir: string, session: string): Promise<string[]> {
  const text = await host.read(join(dir, `${session}${LOG}`));
  if (text === undefined) {
    return ['  No session file'];
  }
  const records = parsed(text) as Message[];
  const cwd = records.find((record) => record.type === 'system' && record.subtype === 'init')?.cwd;
  return records.flatMap((record) => messageLines(record, cwd)).map((line) => `  ${line}`);
}

async function newestRun(host: Host, runs: string): Promise<string | undefined> {
  return (await host.list(runs))
    .filter((name) => name.endsWith(LOG))
    .map((name) => name.slice(0, -LOG.length))
    .sort()
    .at(-1);
}

function section(title: string, lines: string[]): string[] {
  return [title, ...(lines.length === 0 ? ['  none'] : lines)];
}

export async function issueDetail(
  host: Host,
  root: string,
  issue: number,
  runId: string | undefined,
): Promise<string[]> {
  const runs = join(root, '.next-issue', 'runs');
  const id = runId ?? (await newestRun(host, runs));
  const events = (
    id === undefined ? [] : parsed((await host.read(join(runs, `${id}${LOG}`))) ?? '')
  )
    .filter((event) => event['issue'] === issue)
    .sort((left, right) => String(left['ts']).localeCompare(String(right['ts'])));
  const log = ((await host.read(join(root, '.next-issue', 'worker.log'))) ?? '')
    .split('\n')
    .filter((line) => new RegExp(`^\\S+ #${issue} `).test(line));
  const sessionDir = id === undefined ? '' : join(runs, id, 'sessions');
  const sessions = await Promise.all(
    events
      .filter((event) => event['kind'] === 'usage' && typeof event['session'] === 'string')
      .map(async (event) => [
        `Session: ${String(event['role'])}`,
        ...(await sessionLines(host, sessionDir, String(event['session']))),
      ]),
  );
  return [
    `Issue #${issue}${id === undefined ? '' : ` · run ${startTime(id)}`}`,
    ...section(
      'Run events (UTC)',
      events.map((event) => `  ${eventLine(event)}`),
    ),
    ...section(
      'Worker log (local time)',
      log.map((line) => `  ${line}`),
    ),
    ...(sessions.length === 0 ? ['Sessions', '  none'] : sessions.flat()),
  ];
}
