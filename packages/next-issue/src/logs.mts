import { writeSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hasCode, render } from './observe.mts';
import { STATE_DIR } from './state.mts';

const POLL_MS = 200;

export async function newestRunLog(root: string): Promise<string | undefined> {
  const dir = join(root, STATE_DIR, 'runs');
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

export async function followLog(
  file: string,
  options: { json: boolean; tail?: number },
  print: (text: string) => Promise<void>,
): Promise<number> {
  const handle = await open(file, 'r');
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    wake?.();
  };
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let rest = '';
  let first = true;
  try {
    while (!stopped) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        rest += decoder.write(buffer.subarray(0, bytesRead));
        if (bytesRead === buffer.length) {
          continue;
        }
      }
      const lines = rest.split('\n');
      rest = lines.pop()!;
      const filled = lines.filter((line) => line.trim().length > 0);
      const shown = first && options.tail !== undefined ? filled.slice(-options.tail) : filled;
      first = false;
      if (shown.length > 0) {
        await print(shown.map((line) => show(line, options.json)).join(''));
      }
      try {
        writeSync(process.stdout.fd, '');
      } catch {
        stop();
      }
      if (stopped) {
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } catch (error) {
    if (!stopped && !hasCode(error, 'EPIPE')) {
      throw error;
    }
  } finally {
    process.off('SIGINT', stop);
    process.stdout.off('error', stop);
    await handle.close();
  }
  return 0;
}
