import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTime } from './past.ts';

type Entry = Record<string, unknown>;
type Content = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};
type Message = { role?: string; toolName?: string; content?: string | Content[] };

const LOG = '.jsonl';
const HIDDEN = new Set(['ts', 'runId', 'kind', 'issue']);

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

function contentLines(label: string, content: Message['content']): string[] {
  if (typeof content === 'string') {
    return labelled(label, content);
  }
  return (content ?? []).flatMap((item) => {
    if (item.type === 'thinking') {
      return labelled('thinking', item.thinking ?? '');
    }
    if (item.type === 'toolCall') {
      return labelled(`tool call ${item.name ?? ''}`, JSON.stringify(item.arguments ?? {}));
    }
    return item.type === 'text' ? labelled(label, item.text ?? '') : [];
  });
}

function messageLines(message: Message): string[] {
  if (message.role === 'user' || message.role === 'assistant') {
    return contentLines(message.role, message.content);
  }
  if (message.role === 'toolResult') {
    return contentLines(`tool result ${message.toolName ?? ''}`, message.content);
  }
  return [];
}

async function sessionLines(dir: string, names: string[], session: string): Promise<string[]> {
  const name = names.find((item) => item.endsWith(`_${session}${LOG}`));
  if (name === undefined) {
    return ['  No session file'];
  }
  const records = parsed(await readFile(join(dir, name), 'utf8').catch(() => ''));
  return records
    .filter((record) => record['type'] === 'message')
    .flatMap((record) => messageLines((record['message'] ?? {}) as Message))
    .map((line) => `  ${line}`);
}

async function newestRun(runs: string): Promise<string | undefined> {
  const names = await readdir(runs).catch(() => []);
  return names
    .filter((name) => name.endsWith(LOG))
    .map((name) => name.slice(0, -LOG.length))
    .sort()
    .at(-1);
}

function section(title: string, lines: string[]): string[] {
  return [title, ...(lines.length === 0 ? ['  none'] : lines)];
}

export async function issueDetail(
  root: string,
  issue: number,
  runId: string | undefined,
): Promise<string[]> {
  const runs = join(root, '.next-issue', 'runs');
  const id = runId ?? (await newestRun(runs));
  const events = (
    id === undefined
      ? []
      : parsed(await readFile(join(runs, `${id}${LOG}`), 'utf8').catch(() => ''))
  )
    .filter((event) => event['issue'] === issue)
    .sort((left, right) => String(left['ts']).localeCompare(String(right['ts'])));
  const log = (await readFile(join(root, '.next-issue', 'worker.log'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => new RegExp(`^\\S+ #${issue} `).test(line));
  const sessionDir = id === undefined ? '' : join(runs, id, 'sessions');
  const names = id === undefined ? [] : await readdir(sessionDir).catch(() => []);
  const sessions = await Promise.all(
    events
      .filter((event) => event['kind'] === 'usage' && typeof event['session'] === 'string')
      .map(async (event) => [
        `Session: ${String(event['role'])}`,
        ...(await sessionLines(sessionDir, names, String(event['session']))),
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
