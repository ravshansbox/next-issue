import type { Handled, IssueProgress, Progress } from './protocol.ts';

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 120) {
    return seconds < 60 ? `${seconds}s` : `1m${String(seconds - 60).padStart(2, '0')}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const spare = minutes % 60;
  return spare === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h${spare}m`;
}

const OUTCOME_NOTES = { done: 'done', 'needs-human': 'needs a human', error: 'failed' } as const;

type Outcome = keyof typeof OUTCOME_NOTES;

export function outcomeNote(outcome: string): string {
  return OUTCOME_NOTES[outcome as Outcome] ?? outcome;
}

function outcomes(progress: Progress): string {
  const count = (outcome: Outcome): number =>
    progress.handled.filter((item) => item.outcome === outcome).length;
  return (Object.keys(OUTCOME_NOTES) as Outcome[])
    .filter((outcome) => outcome === 'done' || count(outcome) > 0)
    .map((outcome) => `${count(outcome)} ${OUTCOME_NOTES[outcome]}`)
    .join(', ');
}

function failedNote(progress: Progress): string {
  return `failed: ${progress.error ?? 'unknown error'}`;
}

export function handledNote(item: Handled): string {
  return `#${item.issue} ${OUTCOME_NOTES[item.outcome]}`;
}

export type Note = { text: string; level: 'info' | 'warning' | 'error' };

export type Action = 'start' | 'stop' | 'watch' | 'hunt' | 'refresh';

export function cannotNote(action: Action, message: string): Note {
  return { text: `next-issue cannot ${action}: ${message}`, level: 'error' };
}

export function formatQuestions(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'} waiting`;
}

export function issueLine(item: IssueProgress, now: number): string {
  const parts = [`#${item.issue}`, item.stage ?? 'prepare'];
  if (item.startedAt !== undefined) {
    parts.push(duration(now - item.startedAt));
  }
  return parts.join(' · ');
}

export function formatStatus(progress: Progress, now: number): string {
  const running = progress.issues ?? [];
  switch (progress.status) {
    case 'running': {
      const line =
        running.length === 0
          ? 'looking for issues'
          : running.map((item) => issueLine(item, now)).join(' | ');
      const open = progress.open;
      return open === undefined ? line : `${open} ${open === 1 ? 'issue' : 'issues'} · ${line}`;
    }
    case 'stopping': {
      const issues = running.map((item) => `#${item.issue}`);
      const upgrade = progress.upgrade;
      return `${issues.length === 0 ? '#?' : issues.join(' ')} · ${upgrade === undefined ? 'stopping' : `upgrading to ${upgrade.to}`}`;
    }
    case 'stopped':
    case 'finished':
      return `${progress.status}: ${outcomes(progress)}`;
    case 'failed':
      return failedNote(progress);
  }
}
