import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function workerArgs(version: string): string[] {
  return ['-y', `next-issue@${version === '0.0.0' ? 'latest' : version}`, 'serve'];
}

export function workerPaths(root: string): { socketPath: string; logPath: string } {
  const stateDir = join(root, '.next-issue');
  return {
    socketPath: join(stateDir, 'worker.sock'),
    logPath: join(stateDir, 'worker.log'),
  };
}

export function spawnWorker(root: string, version: string): void {
  const { logPath } = workerPaths(root);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const child = spawn('npx', workerArgs(version), {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}
