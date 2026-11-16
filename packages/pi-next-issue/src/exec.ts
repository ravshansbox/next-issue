import { spawn } from 'node:child_process';

type Result = { code: number; stdout: string; stderr: string };

type RunOptions = { cwd: string };

function run(command: string, args: string[], options: RunOptions): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
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
