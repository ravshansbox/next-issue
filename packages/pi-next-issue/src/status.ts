import type { Handled, Progress } from './protocol.ts';

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

const OUTCOME_NOTES = { done: 'done', 'needs-human': 'needs a human', error: 'failed' } as const;

type Outcome = keyof typeof OUTCOME_NOTES;

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

export function statusNote(progress: Progress): Note | undefined {
  if (progress.status === 'finished' || progress.status === 'stopped') {
    return { text: `next-issue ${progress.status}`, level: 'info' };
  }
  if (progress.status === 'failed') {
    return { text: `next-issue ${failedNote(progress)}`, level: 'error' };
  }
  return undefined;
}

export function handledNotes(progress: Progress, from: number): Note[] {
  return progress.handled.slice(from).map((item) => ({
    text: `next-issue: ${handledNote(item)}`,
    level: item.outcome === 'done' ? 'info' : 'warning',
  }));
}

export function formatQuestions(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'} waiting`;
}

export function formatStatus(progress: Progress, now: number): string {
  const running = progress.issues ?? [];
  switch (progress.status) {
    case 'running': {
      if (running.length === 0) {
        return 'looking for issues';
      }
      const count = progress.open === undefined ? '' : `/${progress.open}`;
      const lines = running.map((item) => {
        const parts = [`#${item.issue}${count}`, item.stage ?? 'prepare', `${item.tools} tools`];
        if (item.startedAt !== undefined) {
          parts.push(duration(now - item.startedAt));
        }
        return parts.join(' · ');
      });
      return lines.join(' | ');
    }
    case 'stopping': {
      const issues = running.map((item) => `#${item.issue}`);
      return `${issues.length === 0 ? '#?' : issues.join(' ')} · stopping`;
    }
    case 'stopped':
    case 'finished':
      return `${progress.status}: ${outcomes(progress)}`;
    case 'failed':
      return failedNote(progress);
  }
}
