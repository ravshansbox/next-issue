import { writeSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hasCode, render, runsDir } from './observe.mts';

const POLL_MS = 200;

export async function newestRunLog(root: string): Promise<string | undefined> {
  const dir = runsDir(root);
  const names = await readdir(dir).catch(() => []);
  const newest = names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .at(-1);
  return newest === undefined ? undefined : join(dir, newest);
}

function show(line: string, json: boolean): string {
  if (json) {
    return `${line}\n`;
  }
  try {
    return render(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return '';
  }
}

function completeLines(text: string, tail?: number): { shown: string[]; rest: string } {
  const lines = text.split('\n');
  const rest = lines.pop()!;
  const filled = lines.filter((line) => line.trim().length > 0);
  return { shown: tail === undefined ? filled : filled.slice(-tail), rest };
}

function stdoutOpen(): boolean {
  try {
    writeSync(process.stdout.fd, '');
    return true;
  } catch {
    return false;
  }
}

type Stopper = { readonly stopped: boolean; stop: () => void; pause: () => Promise<void> };

function stopper(): Stopper {
  let stopped = false;
  let wake: (() => void) | undefined;
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      wake?.();
    },
    async pause() {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    },
  };
}

export async function followLog(
  file: string,
  options: { json: boolean; tail?: number },
  print: (text: string) => Promise<void>,
): Promise<number> {
  const handle = await open(file, 'r');
  const control = stopper();
  const { stop } = control;
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let rest = '';
  let first = true;
  try {
    while (!control.stopped) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        rest += decoder.write(buffer.subarray(0, bytesRead));
        if (bytesRead === buffer.length) {
          continue;
        }
      }
      const complete = completeLines(rest, first ? options.tail : undefined);
      rest = complete.rest;
      first = false;
      const { shown } = complete;
      if (shown.length > 0) {
        await print(shown.map((line) => show(line, options.json)).join(''));
      }
      if (!stdoutOpen()) {
        stop();
      }
      if (control.stopped) {
        break;
      }
      await control.pause();
    }
  } catch (error) {
    if (!control.stopped && !hasCode(error, 'EPIPE')) {
      throw error;
    }
  } finally {
    process.off('SIGINT', stop);
    process.stdout.off('error', stop);
    await handle.close();
  }
  return 0;
}
