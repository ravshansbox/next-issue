import { appendFile, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { must, run } from './exec.ts';

export const WORKTREE_DIR = '.worktrees';

export async function repoRoot(cwd: string): Promise<string> {
  return must('git', ['rev-parse', '--show-toplevel'], { cwd });
}

export function parseRemote(url: string): string {
  const remote = url.trim();
  const hosted =
    /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  if (hosted !== null) {
    const [, host, owner, name] = hosted;
    return host?.toLowerCase() === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
  }
  const path = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (path === null) {
    throw new Error(`cannot read the owner and name from the git remote ${url}`);
  }
  return `${path[1]}/${path[2]}`;
}

export async function remoteSlug(root: string, remote: string): Promise<string> {
  return parseRemote(await must('git', ['remote', 'get-url', remote], { cwd: root }));
}

async function ignoreWorktrees(root: string): Promise<void> {
  const common = await must('git', ['rev-parse', '--git-common-dir'], { cwd: root });
  const file = join(isAbsolute(common) ? common : join(root, common), 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (!current.split('\n').some((line) => line.trim() === `/${WORKTREE_DIR}/`)) {
    const gap = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${gap}/${WORKTREE_DIR}/\n`);
  }
}

async function findWorktree(root: string, branch: string): Promise<string | undefined> {
  const list = await must('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  const entry = list
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`));
  return entry?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
}

async function hasRef(root: string, ref: string): Promise<boolean> {
  return (await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root })).code === 0;
}

export async function worktree(
  root: string,
  remote: string,
  base: string,
  issue: number,
  branch: string,
): Promise<string> {
  await ignoreWorktrees(root);
  await must('git', ['fetch', remote], { cwd: root });
  await must('git', ['worktree', 'prune'], { cwd: root });
  const existing = await findWorktree(root, branch);
  if (existing !== undefined) {
    return existing;
  }
  const path = join(root, WORKTREE_DIR, String(issue));
  if (await hasRef(root, `refs/heads/${branch}`)) {
    await must('git', ['worktree', 'add', path, branch], { cwd: root });
  } else {
    const upstream = `${remote}/${branch}`;
    const start = (await hasRef(root, `refs/remotes/${upstream}`)) ? upstream : `${remote}/${base}`;
    await must('git', ['worktree', 'add', '--no-track', '-b', branch, path, start], { cwd: root });
  }
  return path;
}

export async function commit(cwd: string, message: string): Promise<boolean> {
  if ((await must('git', ['status', '--porcelain'], { cwd })).length === 0) {
    return false;
  }
  await must('git', ['add', '-A'], { cwd });
  await must('git', ['commit', '-m', message], { cwd });
  return true;
}

export async function ahead(
  cwd: string,
  remote: string,
  base: string,
): Promise<string | undefined> {
  const range = `${remote}/${base}..HEAD`;
  const subjects = await must('git', ['log', '--reverse', '--format=%s', range], { cwd });
  return subjects.split('\n')[0] || undefined;
}

export async function push(cwd: string, remote: string, branch: string): Promise<void> {
  await must('git', ['push', '-u', remote, `HEAD:refs/heads/${branch}`], { cwd });
}

export async function discard(cwd: string, remote: string, branch: string): Promise<void> {
  await must('git', ['reset', '--hard', `${remote}/${branch}`], { cwd });
  await must('git', ['clean', '-fd'], { cwd });
}

export async function diff(cwd: string, remote: string, base: string): Promise<string> {
  await must('git', ['fetch', remote, base], { cwd });
  return must('git', ['diff', `${remote}/${base}...HEAD`], { cwd });
}

export async function head(cwd: string): Promise<string> {
  return must('git', ['rev-parse', 'HEAD'], { cwd });
}

export async function cleanup(
  root: string,
  remote: string,
  branch: string,
  path: string,
): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', path], { cwd: root });
  await run('git', ['branch', '-D', branch], { cwd: root });
  await run('git', ['push', remote, '--delete', branch], { cwd: root });
}
