import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { message, parseJson } from './errors.mts';
import { readTextIfPresent } from './files.mts';

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
  if (await exists(join(root, 'package.json'))) {
    return 'npm install --no-package-lock';
  }
  return undefined;
}

export const SCRIPTS = ['format', 'lint', 'typecheck', 'test'];

const RUNNERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm run'],
  ['package-lock.json', 'npm run'],
  ['yarn.lock', 'yarn run'],
  ['bun.lock', 'bun run'],
  ['bun.lockb', 'bun run'],
];

/** The command that runs a package script, from the lock file of the package manager. */
export async function scriptRunner(root: string): Promise<string> {
  for (const [file, runner] of RUNNERS) {
    if (await exists(join(root, file))) {
      return runner;
    }
  }
  return 'npm run';
}

function listed(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length === 1
    ? quoted[0]!
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

const WHY = `next-issue runs ${listed(SCRIPTS)} before each push, since the humanless flow relies on these checks instead of a person. Each script must fail on a problem, and \`format\` must check the formatting, not write files.`;

/** Fails when the root `package.json` is missing or lacks any of the scripts of the local gate. */
export async function requireScripts(root: string): Promise<void> {
  const text = await readTextIfPresent(join(root, 'package.json'));
  if (text === undefined) {
    throw new Error(
      `there is no package.json at the root of the repository, so it lacks the scripts ${listed(SCRIPTS)}. ${WHY}`,
    );
  }
  const file = parseJson(text, (error) => `package.json is not valid JSON: ${message(error)}`);
  const scripts = (file as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
  const missing = SCRIPTS.filter((name) => typeof scripts[name] !== 'string');
  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'script' : 'scripts';
    throw new Error(`the root package.json lacks the ${noun} ${listed(missing)}. ${WHY}`);
  }
}
