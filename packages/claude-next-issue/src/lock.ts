import type { Host } from './host.ts';

async function processStart(host: Host, pid: number): Promise<string | undefined> {
  const stat = (await host.read(`/proc/${pid}/stat`)) ?? '';
  if (stat !== '') {
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  const result = await host
    .run(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
    .catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

export async function isAlive(host: Host, pid: number): Promise<boolean> {
  const result = await host.run(['kill', '-0', String(pid)]).catch(() => undefined);
  return result !== undefined && (result.exitCode === 0 || /not permitted/i.test(result.stderr));
}

export async function lockHolder(host: Host, lockPath: string): Promise<number | undefined> {
  const [first = '', ...rest] = ((await host.read(lockPath)) ?? '').trim().split(' ');
  const pid = Number(first);
  const started = rest.join(' ');
  if (!(pid > 0)) {
    return undefined;
  }
  if (started === '') {
    return (await isAlive(host, pid)) ? pid : undefined;
  }
  return (await processStart(host, pid)) === started ? pid : undefined;
}
