import type { Handled, IssueProgress, Progress, Question } from './protocol.ts';

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

export type Action = 'start' | 'stop' | 'watch' | 'hunt';

export function cannotNote(action: Action, message: string): Note {
  return { text: `next-issue cannot ${action}: ${message}`, level: 'error' };
}

export function switchNote(name: 'watching' | 'hunting', on: boolean): Note {
  return { text: `next-issue: ${name} ${on ? 'on' : 'off'}`, level: 'info' };
}

export function handledNotes(progress: Progress, from: number): Note[] {
  return progress.handled.slice(from).map((item) => ({
    text: `next-issue: ${handledNote(item)}`,
    level: item.outcome === 'done' ? 'info' : 'warning',
  }));
}

export function questionNotes(questions: Question[], known: number[] | undefined): Note[] {
  if (known === undefined) {
    return [];
  }
  return questions
    .filter((question) => !known.includes(question.issue))
    .map((question) => ({
      text: `next-issue: #${question.issue} has a question: ${question.title}${/[.?!]$/.test(question.title) ? '' : '.'} Ask pi to answer it with the answer-hand-over skill.`,
      level: 'warning',
    }));
}

export function formatQuestions(count: number): string {
  return `${count} ${count === 1 ? 'question' : 'questions'} waiting`;
}

function issueLine(item: IssueProgress, now: number): string {
  const parts = [`#${item.issue}`, item.stage ?? 'prepare', `${item.tools} tools`];
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
      return `${issues.length === 0 ? '#?' : issues.join(' ')} · stopping`;
    }
    case 'stopped':
    case 'finished':
      return `${progress.status}: ${outcomes(progress)}`;
    case 'failed':
      return failedNote(progress);
  }
}
