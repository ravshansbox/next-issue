import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { showingCommands } from '../shared/exec.mts';

export const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP_BYTES = 5 * 1024 * 1024;
export const LOG_CHECK_MS = 60_000;

export function trimLog(path: string): void {
  if (showingCommands()) {
    return;
  }
  try {
    const file = openSync(path, 'r+');
    try {
      const size = fstatSync(file).size;
      if (size <= LOG_LIMIT_BYTES) {
        return;
      }
      const tail = Buffer.alloc(LOG_KEEP_BYTES);
      const read = readSync(file, tail, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
      const kept = tail.subarray(tail.indexOf(10) + 1, read);
      writeSync(file, kept, 0, kept.length, 0);
      ftruncateSync(file, kept.length + copyAppended(file, size, kept.length));
    } finally {
      closeSync(file);
    }
  } catch {
    return;
  }
}

function copyAppended(file: number, from: number, to: number): number {
  let read = from;
  let written = to;
  for (let size = fstatSync(file).size; read < size; size = fstatSync(file).size) {
    const appended = Buffer.alloc(size - read);
    const length = readSync(file, appended, 0, appended.length, read);
    writeSync(file, appended, 0, length, written);
    read += length;
    written += length;
  }
  return written - to;
}

export function keepLogTrimmed(path: string, checkMs: number): () => void {
  trimLog(path);
  const timer = setInterval(() => trimLog(path), checkMs);
  timer.unref();
  return () => clearInterval(timer);
}
