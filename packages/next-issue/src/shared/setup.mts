import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { message, parseJson } from './errors.mts';
import { run, succeeded } from './exec.mts';
import { gitFetch, remoteRef, type Repo } from './git.mts';
import { defaultBranch } from './github.mts';

const JS_MARKERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
];

const OTHER_MARKERS: Array<[string, string]> = [
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

async function firstMatch(
  root: string,
  markers: Array<[string, string]>,
): Promise<[string, string] | undefined> {
  for (const marker of markers) {
    if (await exists(join(root, marker[0]))) {
      return marker;
    }
  }
  return undefined;
}

async function jsLockCommand(root: string): Promise<string | undefined> {
  const match = await firstMatch(root, JS_MARKERS);
  if (match === undefined) {
    return undefined;
  }
  const [file, command] = match;
  if (file === 'yarn.lock' && (await exists(join(root, '.yarnrc.yml')))) {
    return 'yarn install --immutable';
  }
  return command;
}

export async function detectSetupCommand(root: string): Promise<string | undefined> {
  const jsCommand = await jsLockCommand(root);
  const otherCommand = (await firstMatch(root, OTHER_MARKERS))?.[1];
  const fallback =
    jsCommand === undefined && (await exists(join(root, 'package.json')))
      ? 'npm install --no-package-lock'
      : undefined;
  const commands = [jsCommand, otherCommand, fallback].filter(
    (command): command is string => command !== undefined,
  );
  return commands.length === 0 ? undefined : commands.join(' && ');
}

export const SCRIPTS = ['format', 'lint', 'typecheck', 'test'];

const RUNNERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm run'],
  ['package-lock.json', 'npm run'],
  ['yarn.lock', 'yarn run'],
  ['bun.lock', 'bun run'],
  ['bun.lockb', 'bun run'],
];

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

const PACKED_REFS_WAIT_MS = 10_000;

export type BasePackage = { base: string; text: string | undefined };

export async function basePackage(repo: Repo, remote: string): Promise<BasePackage> {
  const branch = await defaultBranch(repo);
  const ref = `refs/next-issue/base-${randomUUID()}`;
  try {
    await gitFetch(repo.root, [
      '--no-write-fetch-head',
      '--refmap=',
      remote,
      `+refs/heads/${branch}:${ref}`,
    ]);
    const result = await run('git', ['show', `${ref}:package.json`], { cwd: repo.root });
    return { base: remoteRef(remote, branch), text: succeeded(result) ? result.stdout : undefined };
  } finally {
    await run(
      'git',
      ['-c', `core.packedRefsTimeout=${PACKED_REFS_WAIT_MS}`, 'update-ref', '-d', ref],
      {
        cwd: repo.root,
      },
    );
  }
}

export function requireScripts({ base, text }: BasePackage): void {
  if (text === undefined) {
    throw new Error(
      `there is no package.json at the root of \`${base}\`, so it lacks the scripts ${listed(SCRIPTS)}. Commit them and push them to \`${base}\`. ${WHY}`,
    );
  }
  const file = parseJson(
    text,
    (error) => `the package.json on \`${base}\` is not valid JSON: ${message(error)}`,
  );
  const scripts = (file as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
  const missing = SCRIPTS.filter((name) => typeof scripts[name] !== 'string');
  if (missing.length > 0) {
    const [noun, pronoun] = missing.length === 1 ? ['script', 'it'] : ['scripts', 'them'];
    throw new Error(
      `the package.json on \`${base}\` lacks the ${noun} ${listed(missing)}. Commit ${pronoun} and push ${pronoun} to \`${base}\`. ${WHY}`,
    );
  }
}
