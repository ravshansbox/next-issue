import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  inherit?: boolean;
  timeoutMs?: number;
  tailChars?: number;
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

let defaultTimeoutMs = 10 * 60_000;

export function setCommandObserver(next: (record: CommandRecord) => void): void {
  observer = next;
}

export function setDefaultTimeout(ms: number): void {
  defaultTimeoutMs = ms;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const limit = options.timeoutMs ?? defaultTimeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.inherit === true ? "inherit" : "pipe",
        "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.tailChars !== undefined && stdout.length > options.tailChars) {
        stdout = stdout.slice(-options.tailChars);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limit);
    let done = false;
    child.on("error", (error) => {
      clearTimeout(timer);
      done = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (done) {
        return;
      }
      done = true;
      const result = { code: code ?? 1, stdout, stderr, timedOut };
      observer?.({
        command,
        args,
        cwd: options.cwd,
        code: result.code,
        ms: Date.now() - started,
        stderr: result.code === 0 ? "" : stderr.trim(),
        timedOut,
      });
      resolve(result);
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

export async function must(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.timedOut) {
    throw new Error(`${command} ${args.join(" ")} did not finish in time.`);
  }
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
