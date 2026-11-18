import { going, type Progress, type StopPoint } from './protocol.ts';

export type Action = { label: string; args: string };

export const STOP_CHOICES: Array<{ value: StopPoint; description: string }> = [
  { value: 'issue', description: 'Stop after the running issues' },
  { value: 'round', description: 'Stop after the current round of each running issue' },
  { value: 'now', description: 'Stop at once' },
];

export function menuChoices(progress: Progress | undefined): Record<string, string> {
  if (!going(progress)) {
    return { Start: 'start' };
  }
  return {
    Stop: 'stop',
    ...(progress.watching === true ? { 'Watch off': 'watch off' } : { 'Watch on': 'watch on' }),
    ...(progress.hunting ? { 'Hunt off': 'hunt off' } : { 'Hunt on': 'hunt on' }),
    Refresh: 'refresh',
  };
}

export function dashboardActions(progress: Progress | undefined): Action[] {
  return Object.entries(menuChoices(progress)).flatMap(([label, args]) =>
    args === 'stop'
      ? STOP_CHOICES.map(({ value, description }) => ({
          label: description,
          args: `stop ${value}`,
        }))
      : [{ label, args }],
  );
}
