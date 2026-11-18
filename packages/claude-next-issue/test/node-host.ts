import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { Host, Ran } from '../src/host.ts';

export const nodeHost: Host = {
  request: (socketPath, method, body) =>
    new Promise((resolve, reject) => {
      const sent = request({ socketPath, method, path: '/' }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      });
      sent.on('error', reject);
      sent.end(body);
    }),
  run: (argv, options) =>
    new Promise<Ran>((resolve, reject) => {
      const [command = '', ...args] = argv;
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    }),
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  read: (path) => readFile(path, 'utf8').catch(() => undefined),
  list: (dir) => readdir(dir).catch(() => []),
};
