import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('the worker picks no command for a project without a lock file', async () => {
  assert.equal(await detectSetupCommand(await project('package.json')), undefined);
});

test('the worker picks no command for a folder that is not there', async () => {
  assert.equal(await detectSetupCommand(join(tmpdir(), 'next-issue-does-not-exist')), undefined);
});
