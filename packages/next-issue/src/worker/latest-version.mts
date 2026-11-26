import type { Launch } from '../shared/protocol.mts';

export const NPM_LATEST = 'https://registry.npmjs.org/next-issue/latest';

const LATEST_TIMEOUT_MS = 3_000;

export async function latestVersion(registry: string): Promise<string | undefined> {
  try {
    const response = await fetch(registry, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

export function npxLaunch(version: string): Launch {
  return { command: 'npx', args: ['-y', `next-issue@${version}`, 'serve'] };
}

export function npxVersionCheck(version: string): Launch {
  return { command: 'npx', args: ['-y', `next-issue@${version}`, '--version'] };
}
