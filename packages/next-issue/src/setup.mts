import { access } from 'node:fs/promises';
import { join } from 'node:path';

const MARKERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['Cargo.lock', 'cargo fetch --locked'],
  ['go.sum', 'go mod download'],
  ['uv.lock', 'uv sync --locked'],
  ['poetry.lock', 'poetry install'],
  ['Gemfile.lock', 'BUNDLE_FROZEN=true bundle install'],
];

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function detectSetupCommand(root: string): Promise<string | undefined> {
  for (const [file, command] of MARKERS) {
    if (!(await exists(join(root, file)))) {
      continue;
    }
    if (file === 'yarn.lock' && (await exists(join(root, '.yarnrc.yml')))) {
      return 'yarn install --immutable';
    }
    return command;
  }
  return undefined;
}
