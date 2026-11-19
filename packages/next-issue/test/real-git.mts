import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRequest } from '../src/shared/agents.mts';
import { commitAll } from '../src/shared/git-commit.mts';
import { pushToBase, revertOnBase, squashOnto } from '../src/shared/git-land.mts';
import { abortMerge, commitMerge, startMerge } from '../src/shared/git-merge.mts';
import {
  diff,
  discardChanges,
  isDirty,
  isLanded,
  latestSubject,
  revision,
  saveEdits,
  saveSetupOutput,
  setAside,
} from '../src/shared/git.mts';
import type { Recorder } from '../src/shared/observe.mts';
import { addWorktree, findWorktree, removeWorktree } from '../src/shared/worktree.mts';
import { git } from './clones.mts';
import type { Harness } from './harness.mts';

const REAL_GIT = {
  abortMerge,
  addWorktree,
  commitAll,
  commitMerge,
  diff,
  discardChanges,
  findWorktree,
  isDirty,
  isLanded,
  latestSubject,
  pushToBase,
  removeWorktree,
  revertOnBase,
  revision,
  saveEdits,
  saveSetupOutput,
  setAside,
  squashOnto,
  startMerge,
};

export type Files = Record<string, string>;

export async function writeFiles(cwd: string, files: Files): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(cwd, name), text);
  }
}

export async function pushBase(other: string, files: Files): Promise<void> {
  await git(other, 'fetch', '-q', 'origin');
  await git(other, 'reset', '-q', '--hard', 'origin/main');
  await writeFiles(other, files);
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', 'base');
  await git(other, 'push', '-q', 'origin', 'main');
}

export function useGit(
  target: Harness,
  fixer: (worktree: string, call: number) => Promise<unknown>,
): void {
  const { ports } = target.context;
  const fake = ports.runAgent;
  let calls = 0;
  Object.assign(ports, {
    ...REAL_GIT,
    runAgent: async (recorder: Recorder, request: AgentRequest) => {
      if (request.name === 'fixer') {
        calls += 1;
        await fixer(request.cwd, calls);
      } else {
        await writeFile(join(request.cwd, `${request.name}.txt`), `${request.name}\n`);
      }
      return fake(recorder, request);
    },
  });
}

export async function remoteMain(other: string): Promise<string> {
  await git(other, 'fetch', '-q', 'origin');
  return git(other, 'rev-parse', 'origin/main');
}

export async function landedNames(other: string): Promise<string[]> {
  const landed = await remoteMain(other);
  return (await git(other, 'ls-tree', '--name-only', landed)).split('\n');
}

export async function landedFiles(other: string): Promise<Files> {
  const landed = await remoteMain(other);
  const names = await landedNames(other);
  const files: Files = {};
  for (const name of names) {
    files[name] = await git(other, 'show', `${landed}:${name}`);
  }
  return files;
}
