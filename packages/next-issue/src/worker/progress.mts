import type { Fields } from '../shared/observe.mts';
import type { Progress } from '../shared/protocol.mts';

export function startProgress(hunting = false): Progress {
  return { status: 'running', hunting };
}

export function applyEvent(progress: Progress, record: Fields): Progress {
  if (record['kind'] === 'issues.fail') {
    return { ...progress, error: String(record['error']) };
  }
  return progress;
}
