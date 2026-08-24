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
};

export type CommandRecord = {
  command: string;
  args: string[];
  cwd?: string;
  code: number;
  ms: number;
  stderr: string;
};

let observer: ((record: CommandRecord) => void) | undefined;

export function setCommandObserver(next: (record: CommandRecord) => void): void {
  observer = next;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
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
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr, timedOut };
      observer?.({
        command,
        args,
        cwd: options.cwd,
        code: result.code,
        ms: Date.now() - started,
        stderr: result.code === 0 ? "" : stderr.trim(),
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
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
