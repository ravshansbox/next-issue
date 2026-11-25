import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { must } from '../src/shared/exec.mts';
import { tempDir } from './temp-dir.mts';

export const ALL_SCRIPTS = ['format', 'lint', 'typecheck', 'test'];

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

const servedBases = new Map<string, string>();

export async function repository(origin?: string): Promise<string> {
  const root = await realpath(await tempDir());
  await must('git', ['init', '-q'], { cwd: root });
  await writeScripts(root, ALL_SCRIPTS);
  if (origin !== undefined) {
    await must('git', ['remote', 'add', 'origin', origin], { cwd: root });
    await serveBase(root);
  }
  return root;
}

/** Serves the remote `origin` of `root` (an ssh url) from `served`, by default a new repository whose `main` holds a package.json with all four scripts. */
export async function serveBase(root: string, served?: string): Promise<void> {
  const origin = served ?? (await baseWithScripts());
  const ssh = join(await tempDir(), 'ssh.sh');
  await writeFile(ssh, `verb="\${2%% *}"\nexec git "\${verb#git-}" '${origin}'\n`);
  await must('git', ['config', 'core.sshCommand', `sh '${ssh}'`], { cwd: root });
  await must('git', ['config', 'ssh.variant', 'simple'], { cwd: root });
  servedBases.set(root, origin);
}

async function baseWithScripts(): Promise<string> {
  const served = await realpath(await tempDir());
  await must('git', ['init', '-q'], { cwd: served });
  await writeScripts(served, ALL_SCRIPTS);
  await must('git', ['add', '.'], { cwd: served });
  await must('git', [...IDENTITY, 'commit', '-q', '-m', 'scripts'], { cwd: served });
  await must('git', ['branch', '-M', 'main'], { cwd: served });
  return served;
}

/** Commits a package.json with only the given scripts on the served base of `root`. */
export function pushScripts(root: string, scripts: string[]): Promise<void> {
  return pushPackage(root, scriptsJson(scripts));
}

/** Commits the given package.json text (no file for `null`) on the served base of `root`. */
export async function pushPackage(root: string, text: string | null): Promise<void> {
  const served = servedBases.get(root)!;
  if (text === null) {
    await must('git', ['rm', '-q', 'package.json'], { cwd: served });
  } else {
    await writeFile(join(served, 'package.json'), text);
    await must('git', ['add', 'package.json'], { cwd: served });
  }
  await must('git', [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'scripts'], {
    cwd: served,
  });
}

function scriptsJson(scripts: string[]): string {
  const entries = scripts.map((script) => [script, 'true']);
  return `${JSON.stringify({ scripts: Object.fromEntries(entries) })}\n`;
}

/** Writes a root `package.json` with only the given scripts. */
export function writeScripts(root: string, scripts: string[]): Promise<void> {
  return writeFile(join(root, 'package.json'), scriptsJson(scripts));
}

export async function linkedWorktree(root: string): Promise<string> {
  await must(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const linked = join(root, '.claude', 'worktrees', '42');
  await must('git', ['worktree', 'add', '-q', '-b', '42', linked], { cwd: root });
  return linked;
}

/** Makes a person's own worktree `.worktrees/42` on branch 42 with an edited tracked file, an untracked file and an ignored `.env`, and returns a check that it is unchanged. */
export async function personWorktree(
  root: string,
): Promise<{ path: string; assertKept: () => Promise<void> }> {
  await must('git', ['config', 'user.name', 't'], { cwd: root });
  await must('git', ['config', 'user.email', 't@t'], { cwd: root });
  await must('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: root });
  const path = join(root, '.worktrees', '42');
  await must('git', ['worktree', 'add', '-q', '-b', '42', path], { cwd: root });
  await writeFile(join(path, '.gitignore'), '.env\n');
  await writeFile(join(path, 'tracked.txt'), 'committed\n');
  await must('git', ['add', '.'], { cwd: path });
  await must('git', ['commit', '-q', '-m', 'mine'], { cwd: path });
  const files = { 'tracked.txt': 'edited\n', 'untracked.txt': 'new\n', '.env': 'SECRET=1\n' };
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(path, name), text);
  }
  const head = await must('git', ['rev-parse', '42'], { cwd: root });
  const assertKept = async () => {
    assert.equal(await must('git', ['branch', '--show-current'], { cwd: path }), '42');
    assert.equal(await must('git', ['rev-parse', '42'], { cwd: root }), head);
    for (const [name, text] of Object.entries(files)) {
      assert.equal(await readFile(join(path, name), 'utf8'), text);
    }
    assert.equal(await must('git', ['branch', '--list', '42-detached-*'], { cwd: root }), '');
  };
  return { path, assertKept };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(check: () => boolean, what: string): Promise<void> {
  for (let left = 1200; left > 0; left -= 1) {
    if (check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
