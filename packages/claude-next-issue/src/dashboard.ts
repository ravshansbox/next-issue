import { going, type Progress, type Question, type Upcoming } from './protocol.ts';
import { formatQuestions, formatStatus } from './status.ts';

export const TABS = ['Active', 'Past', 'Hand-overs', 'Upcoming'] as const;

export type Tab = (typeof TABS)[number];

function onOff(on: boolean | undefined): string {
  return on === true ? 'on' : 'off';
}

export function runLines(progress: Progress | undefined): string[] {
  const error = progress?.error === undefined ? [] : [`Error: ${progress.error}`];
  const last = progress === undefined ? [] : [`Last run: ${progress.status}`];
  if (going(progress)) {
    return [
      `Status: ${progress.status}`,
      `Watching: ${onOff(progress.watching)}`,
      `Hunting: ${onOff(progress.hunting)}`,
      ...(progress.open === undefined ? [] : [`Open issues: ${progress.open}`]),
      ...error,
    ];
  }
  return ['No run is going.', ...last, ...error];
}

export function handOverNote(
  questions: Question[] | undefined,
  connected: boolean,
): string | undefined {
  if (questions === undefined && !connected) {
    return 'No worker is running, so the hand-overs cannot be listed. Answer them with the answer-hand-over skill.';
  }
  if (questions === undefined) {
    return 'Waiting for the hand-overs from the worker…';
  }
  return questions.length === 0 ? 'No issue waits for a person.' : undefined;
}

export function upcomingLines(upcoming: Upcoming | string | undefined): string[] {
  if (upcoming === undefined) {
    return ['Loading the upcoming issues…'];
  }
  if (typeof upcoming === 'string') {
    return [upcoming];
  }
  const listed = (title: string, lines: string[]) => [
    title,
    ...(lines.length === 0 ? ['  none'] : lines),
  ];
  return [
    ...listed(
      'Claimable, in the order the worker claims them',
      upcoming.claimable.map((item) => `  #${item.issue} ${item.title}`),
    ),
    '',
    ...listed(
      'Blocked',
      upcoming.blocked.map(
        (item) => `  #${item.issue} ${item.title}, blocked by ${item.blockers.join(', ')}`,
      ),
    ),
  ];
}

export function statusLine(
  progress: Progress | undefined,
  questions: Question[] | undefined,
  now: number,
): string | undefined {
  const ended =
    progress === undefined || progress.status === 'finished' || progress.status === 'stopped';
  const parts = [
    ...(ended ? [] : [formatStatus(progress, now)]),
    ...(questions === undefined || questions.length === 0
      ? []
      : [formatQuestions(questions.length)]),
  ];
  return parts.length === 0 ? undefined : parts.join(' · ');
}
