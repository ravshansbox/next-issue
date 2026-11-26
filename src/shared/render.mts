import type { Fields } from './observe.mts';
import { truncate } from './text.mts';

export function render(record: Fields): string {
  const time = new Date(String(record.ts)).toTimeString().slice(0, 8);
  const issue = record.issue === undefined ? '' : ` #${record.issue}`;
  const role = record.role === undefined ? '' : `${String(record.role)}.`;
  const kind = String(record.kind);
  const extras = Object.entries(record)
    .filter(([key]) => !['ts', 'runId', 'kind', 'issue', 'role'].includes(key))
    .map(
      ([key, value]) => `${label(kind, key)}=${key === 'command' ? oneLine(value) : short(value)}`,
    )
    .join(' ');
  return `${time}${issue} ${role}${kind}${extras.length > 0 ? ` ${extras}` : ''}\n`;
}

function label(kind: string, key: string): string {
  return key === 'tool' && (kind === 'tool' || kind === 'tool.error') ? 'name' : key;
}

function short(value: unknown): string {
  if (value === undefined || value === null) {
    return '-';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  return truncate(oneLine(value), 120, '...');
}

function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, ' ');
}
