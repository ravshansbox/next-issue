import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';

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

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const defaultTimeout = new AsyncLocalStorage<number>();

const STDERR_TAIL = 200_000;

const groups = new Set<number>();

const stoppers = new Set<() => void>();

export function onStop(stopper: () => void): () => void {
  stoppers.add(stopper);
  return () => stoppers.delete(stopper);
}

export function stopChildren(signal: NodeJS.Signals): void {
  for (const stopper of stoppers) {
    stopper();
  }
  stoppers.clear();
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
  groups.clear();
  process.off('SIGTERM', onTerminate);
  process.kill(process.pid, signal);
}

const onTerminate = (): void => stopChildren('SIGTERM');

function watch(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (groups.size === 0) {
    process.on('SIGTERM', onTerminate);
  }
  groups.add(pid);
}

function unwatch(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  groups.delete(pid);
  if (groups.size === 0) {
    process.off('SIGTERM', onTerminate);
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

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
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      options.onStdout?.(chunk);
      stdout = keepTail(stdout + chunk, options.tailChars);
    });
    const stderrLimit = options.tailChars ?? STDERR_TAIL;
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk, stderrLimit);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);
    let done = false;
    const settle = (code: number | null): void => {
      clearTimeout(timer);
      unwatch(pid);
      if (done) {
        return;
      }
      done = true;
      const result = { code: code ?? 1, stdout, stderr, timedOut };
      notify(command, args, options, started, result);
      resolve(result);
    };
    child.on('error', (error) => {
      clearTimeout(timer);
      unwatch(pid);
      done = true;
      reject(error);
    });
    child.on('exit', (code) => {
      if (!timedOut) {
        return;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(code);
    });
    child.on('close', settle);
    if (options.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }
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
