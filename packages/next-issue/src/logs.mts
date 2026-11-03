import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from './observe.mts';
import { STATE_DIR } from './state.mts';

const POLL_MS = 200;

export async function newestRunLog(root: string): Promise<string | undefined> {
  const dir = join(root, STATE_DIR, 'runs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const newest = names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .at(-1);
  return newest === undefined ? undefined : join(dir, newest);
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
  const show = (line: string): string =>
    options.json ? `${line}\n` : render(JSON.parse(line) as Record<string, unknown>);
  let position = 0;
  let rest = '';
  let first = true;
  try {
    while (!stopped) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        rest += buffer.toString('utf8', 0, bytesRead);
        if (bytesRead === buffer.length) {
          continue;
        }
      }
      const lines = rest.split('\n');
      rest = lines.pop()!;
      let shown = lines.filter((line) => line.trim().length > 0);
      if (first && options.tail !== undefined) {
        shown = shown.slice(-options.tail);
      }
      first = false;
      if (shown.length > 0) {
        await print(shown.map(show).join(''));
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
    if (!stopped && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
      throw error;
    }
  } finally {
    process.off('SIGINT', stop);
    await handle.close();
  }
  return 0;
}
