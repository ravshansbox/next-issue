import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  inherit?: boolean;
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
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
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
