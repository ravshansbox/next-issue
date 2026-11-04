import type { Fields } from './observe.mts';
import { truncate } from './text.mts';

export function render(record: Fields): string {
  const time = new Date(String(record.ts)).toTimeString().slice(0, 8);
  const issue = record.issue === undefined ? '' : ` #${record.issue}`;
  const extras = Object.entries(record)
    .filter(([key]) => !['ts', 'runId', 'kind', 'issue'].includes(key))
    .map(([key, value]) => `${key}=${short(value)}`)
    .join(' ');
  return `${time}${issue} ${String(record.kind)}${extras.length > 0 ? ` ${extras}` : ''}\n`;
}

function short(value: unknown): string {
  if (value === undefined || value === null) {
    return '-';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  return truncate(String(value).replace(/\s+/g, ' '), 120, '...');
}
