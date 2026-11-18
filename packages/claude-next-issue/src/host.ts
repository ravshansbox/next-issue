export type Reply = { status: number; text: string };

export type Ran = { exitCode: number; stdout: string; stderr: string };

export type RunOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number };

export type Host = {
  request: (socketPath: string, method: 'GET' | 'POST', body?: string) => Promise<Reply>;
  run: (argv: string[], options?: RunOptions) => Promise<Ran>;
  pause: (ms: number) => Promise<void>;
  read: (path: string) => Promise<string | undefined>;
  list: (dir: string) => Promise<string[]>;
};

export async function must(host: Host, argv: string[], cwd: string): Promise<string> {
  const result = await host.run(argv, { cwd });
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000);
    throw new Error(`${argv.join(' ')} failed with code ${result.exitCode}: ${detail}`);
  }
  return result.stdout.trim();
}

export function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}
