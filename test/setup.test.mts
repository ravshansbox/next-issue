import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PORTS } from '../src/shared/ports.mts';
import { detectSetupCommand } from '../src/shared/setup.mts';
import { tempDir } from './temp-dir.mts';

async function project(...files: string[]): Promise<string> {
  const path = await tempDir();
  for (const name of files) {
    await writeFile(join(path, name), '');
  }
  return path;
}

test('the worker picks the install command of each lock file', async () => {
  const expected: Array<[string, string]> = [
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
  for (const [file, command] of expected) {
    assert.equal(await detectSetupCommand(await project(file)), command);
  }
});

test('the worker adds the immutable flag for a yarn project with .yarnrc.yml', async () => {
  assert.equal(
    await detectSetupCommand(await project('yarn.lock', '.yarnrc.yml')),
    'yarn install --immutable',
  );
});

test('the worker picks no command for a project with .yarnrc.yml and no yarn.lock', async () => {
  assert.equal(await detectSetupCommand(await project('.yarnrc.yml')), undefined);
});

test('the worker picks the bun command for a project with .yarnrc.yml and bun.lock', async () => {
  assert.equal(
    await detectSetupCommand(await project('.yarnrc.yml', 'bun.lock')),
    'bun install --frozen-lockfile',
  );
});

test('the worker picks pnpm when more than one lock file is present', async () => {
  assert.equal(
    await detectSetupCommand(await project('package-lock.json', 'pnpm-lock.yaml')),
    'pnpm install --frozen-lockfile',
  );
});

test('the worker picks npm install without a lock file for a project with a package.json and no lock file', async () => {
  assert.equal(
    await detectSetupCommand(await project('package.json')),
    'npm install --no-package-lock',
  );
});

test('the worker picks the lock file command for a project with a package.json and a lock file', async () => {
  assert.equal(
    await detectSetupCommand(await project('package.json', 'yarn.lock')),
    'yarn install --frozen-lockfile',
  );
});

test('the worker joins the non-JS install and npm install for a Cargo project with a package.json and no JS lock file', async () => {
  assert.equal(
    await detectSetupCommand(await project('Cargo.lock', 'package.json')),
    'cargo fetch --locked && npm install --no-package-lock',
  );
});

test('the worker joins the JS and the non-JS install for a project with package-lock.json and poetry.lock', async () => {
  assert.equal(
    await detectSetupCommand(await project('package.json', 'package-lock.json', 'poetry.lock')),
    'npm ci && poetry install',
  );
});

test('the worker picks only the first non-JS lock file command when several are present', async () => {
  assert.equal(
    await detectSetupCommand(await project('go.sum', 'Gemfile.lock')),
    'go mod download',
  );
});

test('the worker picks no command for a project with neither a lock file nor a package.json', async () => {
  assert.equal(await detectSetupCommand(await project('README.md')), undefined);
});

test('the worker installs a project with no lock file and leaves no package-lock.json in it', async () => {
  const path = await tempDir();
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name: 'library', version: '1.0.0' }),
  );
  const command = await detectSetupCommand(path);
  assert.ok(command !== undefined);
  const result = await PORTS.runSetup(command, path, 60_000);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(path, 'package-lock.json')), false);
});

test('the worker picks no command for a folder that is not there', async () => {
  assert.equal(await detectSetupCommand(join(tmpdir(), 'next-issue-does-not-exist')), undefined);
});
