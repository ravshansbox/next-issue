import type { Launch } from './protocol.ts';
import { join } from './host.ts';

export function workerPaths(root: string): {
  socketPath: string;
  logPath: string;
  lockPath: string;
} {
  const stateDir = join(root, '.next-issue');
  return {
    socketPath: join(stateDir, 'worker.sock'),
    logPath: join(stateDir, 'worker.log'),
    lockPath: join(stateDir, 'worker.lock'),
  };
}

export function workerLaunch(version: string): Launch {
  return {
    command: 'npx',
    args: ['-y', `next-issue@${version === '0.0.0' ? 'latest' : version}`, 'serve'],
  };
}
