import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

async function textOf(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function processStart(pid: number): Promise<string | undefined> {
  const stat = await textOf(`/proc/${pid}/stat`);
  if (stat !== '') {
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// Reads `.next-issue/worker.lock` as the next-issue CLI writes it: "<pid> <start time>".
export async function lockHolder(lockPath: string): Promise<number | undefined> {
  const [first = '', ...rest] = (await textOf(lockPath)).trim().split(' ');
  const pid = Number(first);
  const started = rest.join(' ');
  if (!(pid > 0)) {
    return undefined;
  }
  if (started === '') {
    return isAlive(pid) ? pid : undefined;
  }
  return (await processStart(pid)) === started ? pid : undefined;
}
