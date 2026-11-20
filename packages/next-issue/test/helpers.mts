import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { must } from '../src/shared/exec.mts';
import { tempDir } from './temp-dir.mts';

export async function repository(origin?: string): Promise<string> {
  const root = await realpath(await tempDir());
  await must('git', ['init', '-q'], { cwd: root });
  await writeScripts(root, ['format', 'lint', 'typecheck', 'test']);
  if (origin !== undefined) {
    await must('git', ['remote', 'add', 'origin', origin], { cwd: root });
  }
  return root;
}

/** Writes a root `package.json` with only the given scripts. */
export function writeScripts(root: string, scripts: string[]): Promise<void> {
  const entries = scripts.map((script) => [script, 'true']);
  return writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ scripts: Object.fromEntries(entries) })}\n`,
  );
}

export async function linkedWorktree(root: string): Promise<string> {
  await must(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const linked = join(root, '.worktrees', '42');
  await must('git', ['worktree', 'add', '-q', '-b', '42', linked], { cwd: root });
  return linked;
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
