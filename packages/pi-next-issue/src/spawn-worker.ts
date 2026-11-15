import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function workerArgs(version: string): string[] {
  return ['-y', `next-issue@${version === '0.0.0' ? 'latest' : version}`, 'serve'];
}

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

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code}` : `signal ${signal}`;
}

export function spawnLogged(
  root: string,
  command: string,
  args: string[],
  onExit: (reason: string) => void,
): void {
  const { logPath } = workerPaths(root);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', (error) => onExit(`${command} failed: ${error.message}`));
    // Other processes write to the log too, and the worker trims it, so no line in it is
    // surely this worker's.
    child.on('exit', (code, signal) => {
      onExit(`${exitText(code, signal)} (see .next-issue/worker.log)`);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function spawnWorker(root: string, version: string, onExit: (reason: string) => void): void {
  spawnLogged(root, 'npx', workerArgs(version), onExit);
}
