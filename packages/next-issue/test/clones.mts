import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { must } from '../src/exec.mts';
import type { Repo } from '../src/git.mts';
import { tempDir } from './temp-dir.mts';

export function git(cwd: string, ...args: string[]): Promise<string> {
  return must('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
}

export async function commit(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`);
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-q', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
}

export async function clones(): Promise<{ repo: Repo; other: string }> {
  const base = await tempDir();
  const remote = join(base, 'remote.git');
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const other = join(base, 'other');
  await git(base, 'clone', '-q', remote, other);
  await git(other, 'checkout', '-q', '-B', 'main');
  await commit(other, 'a.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const root = join(base, 'tool');
  await git(base, 'clone', '-q', remote, root);
  return { repo: { owner: 'acme', name: 'tool', root }, other };
}
