import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';
import { killTree, unwatch, watch } from './children.mts';
import { deadline, minutesToMs } from './durations.mts';

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  show?: boolean;
  timeoutMs?: number;
  tailChars?: number;
  onStdout?: (chunk: string) => void;
};

export type CommandRecord = {
  command: string;
  args: string[];
  cwd?: string;
  code: number;
  ms: number;
  stderr: string;
  timedOut: boolean;
};

let observer: ((record: CommandRecord) => void) | undefined;

const DEFAULT_TIMEOUT_MS = minutesToMs(10);

const defaultTimeout = new AsyncLocalStorage<number>();

const STDERR_TAIL = 200_000;

function keepTail(text: string, limit: number | undefined): string {
  return limit !== undefined && text.length > limit ? text.slice(-limit) : text;
}

export function setCommandObserver(next: (record: CommandRecord) => void): void {
  observer = next;
}

export function withDefaultTimeout<T>(ms: number, body: () => Promise<T>): Promise<T> {
  return defaultTimeout.run(ms, body);
}

function spawnChild(command: string, args: string[], options: RunOptions): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: [
      options.input === undefined ? 'ignore' : 'pipe',
      options.show === true ? 2 : 'pipe',
      'pipe',
    ],
  });
}

function sendInput(child: ChildProcess, input: string | undefined): void {
  if (input === undefined) {
    return;
  }
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input);
}

type Output = {
  stdout: string;
  stderr: string;
};

function collect(child: ChildProcess, options: RunOptions): Output {
  const output = { stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    options.onStdout?.(chunk);
    output.stdout = keepTail(output.stdout + chunk, options.tailChars);
  });
  const stderrLimit = options.tailChars ?? STDERR_TAIL;
  child.stderr?.on('data', (chunk: string) => {
    output.stderr = keepTail(output.stderr + chunk, stderrLimit);
  });
  return output;
}

function notify(
  command: string,
  args: string[],
  options: RunOptions,
  started: number,
  result: RunResult,
): void {
  observer?.({
    command,
    args,
    cwd: options.cwd,
    code: result.code,
    ms: Date.now() - started,
    stderr: result.code === 0 ? '' : result.stderr.trim(),
    timedOut: result.timedOut,
  });
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const limit = options.timeoutMs ?? defaultTimeout.getStore() ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, options);
    const pid = child.pid;
    watch(pid);
    const output = collect(child, options);
    const timer = deadline(limit, () => killTree(child));
    let done = false;
    const release = (): void => {
      timer.clear();
      unwatch(pid);
    };
    const settle = (code: number | null): void => {
      release();
      if (done) {
        return;
      }
      done = true;
      const result = { code: code ?? 1, ...output, timedOut: timer.timedOut() };
      notify(command, args, options, started, result);
      resolve(result);
    };
    child.on('error', (error) => {
      release();
      done = true;
      reject(error);
    });
    child.on('exit', (code) => {
      if (!timer.timedOut()) {
        return;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(code);
    });
    child.on('close', settle);
    sendInput(child, options.input);
  });
}

export async function must(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  const commandLine = `${command} ${args.join(' ')}`;
  if (result.timedOut) {
    throw new Error(`${commandLine} did not finish in time.`);
  }
  if (result.code !== 0) {
    throw new Error(`${commandLine} failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}
