import { join } from 'node:path';
import { stateDir } from './state.mts';

export function workerPaths(root: string): {
  socketPath: string;
  lockPath: string;
  logPath: string;
} {
  const directory = stateDir(root);
  return {
    socketPath: join(directory, 'worker.sock'),
    lockPath: join(directory, 'worker.lock'),
    logPath: join(directory, 'worker.log'),
  };
}

export function checkSocketPath(path: string, platform = process.platform): void {
  const size = platform === 'linux' ? 108 : 104;
  const length = Buffer.byteLength(path);
  if (length >= size) {
    throw new Error(
      `the socket path ${path} is too long for this system: ${length} bytes, at most ${size - 1}`,
    );
  }
}
