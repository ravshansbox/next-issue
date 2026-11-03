import { spawn } from 'node:child_process';

export type Result = { code: number; stdout: string; stderr: string };

export type RunOptions = { cwd: string; input?: string; signal?: AbortSignal };

export function run(command: string, args: string[], options: RunOptions): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    }
  });
}

export async function must(command: string, args: string[], options: RunOptions): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.code}: ${detail}`);
  }
  return result.stdout.trim();
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
