import { writeSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { type Sleeper, wakeableSleep } from './durations.mts';
import { hasCode } from './errors.mts';
import { listOrEmpty } from './files.mts';
import { render } from './render.mts';
import { runsDir } from './state.mts';

const POLL_MS = 200;

export async function newestRunLog(root: string): Promise<string | undefined> {
  const dir = runsDir(root);
  const names = await listOrEmpty(dir);
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

async function printLines(
  lines: string[],
  json: boolean,
  print: (text: string) => Promise<void>,
): Promise<void> {
  if (lines.length > 0) {
    await print(lines.map((line) => show(line, json)).join(''));
  }
}

const CHUNK_BYTES = 64 * 1024;

async function readChunk(
  handle: FileHandle,
  position: number,
  decoder: StringDecoder,
): Promise<{ bytesRead: number; text: string; full: boolean }> {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
  const text = bytesRead > 0 ? decoder.write(buffer.subarray(0, bytesRead)) : '';
  return { bytesRead, text, full: bytesRead === buffer.length };
}

type Stopper = { readonly stopped: boolean; stop: () => void; pause: () => Promise<void> };

function stopper(): Stopper {
  let stopped = false;
  const sleeper: Sleeper = {};
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      sleeper.wake?.();
    },
    async pause() {
      await wakeableSleep(sleeper, POLL_MS, stopped);
    },
  };
}

function listenForStop(stop: () => void): () => void {
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);
  return () => {
    process.off('SIGINT', stop);
    process.stdout.off('error', stop);
  };
}

export async function followLog(
  root: string,
  start: string,
  options: { json: boolean; tail?: number },
  print: (text: string) => Promise<void>,
): Promise<number> {
  let file = start;
  let handle = await open(file, 'r');
  const control = stopper();
  const unlisten = listenForStop(control.stop);
  let decoder = new StringDecoder('utf8');
  let position = 0;
  let rest = '';
  let first = true;
  try {
    while (!control.stopped) {
      const newest = await newestRunLog(root);
      const chunk = await readChunk(handle, position, decoder);
      position += chunk.bytesRead;
      rest += chunk.text;
      if (chunk.full) {
        continue;
      }
      const complete = completeLines(rest, first ? options.tail : undefined);
      rest = complete.rest;
      first = false;
      await printLines(complete.shown, options.json, print);
      if (!stdoutOpen()) {
        control.stop();
      }
      if (control.stopped) {
        break;
      }
      if (newest !== undefined && newest > file) {
        const next = await open(newest, 'r');
        await handle.close();
        handle = next;
        file = newest;
        decoder = new StringDecoder('utf8');
        position = 0;
        rest = '';
        if (!options.json) {
          await print(`— new run: ${basename(file)} —\n`);
        }
        continue;
      }
      await control.pause();
    }
  } catch (error) {
    if (!control.stopped && !hasCode(error, 'EPIPE')) {
      throw error;
    }
  } finally {
    unlisten();
    await handle.close();
  }
  return 0;
}
