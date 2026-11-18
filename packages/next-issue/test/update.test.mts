import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { must } from '../src/shared/exec.mts';
import { tempDir } from './temp-dir.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const TERMINAL_STDIN = '--import=data:text/javascript,process.stdin.isTTY=true';

function update(cwd: string, home: string, args: string[]) {
  return promisify(execFile)(process.execPath, [CLI, 'update', ...args], {
    cwd,
    env: { ...process.env, HOME: home },
  });
}

function updateInTerminal(cwd: string, home: string, answer: string) {
  const child = promisify(execFile)(process.execPath, [TERMINAL_STDIN, CLI, 'update'], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  child.child.stdin?.end(answer);
  return child;
}

async function linkedWorktree(): Promise<{ root: string; linked: string }> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: root },
  );
  const linked = join(root, '.worktrees', '42');
  await must('git', ['worktree', 'add', '-q', '-b', '42', linked], { cwd: root });
  return { root, linked };
}

async function assertInstalled(folder: string): Promise<void> {
  for (const file of [
    'create-issue/SKILL.md',
    'create-issue/template.md',
    'answer-hand-over/SKILL.md',
  ]) {
    assert.equal(
      await readFile(join(folder, file), 'utf8'),
      await readFile(join(SKILLS, file), 'utf8'),
      file,
    );
  }
}

test('a user who runs update --scope user outside a repository gets the skills in ~/.claude/skills and output that names them', async () => {
  const home = await tempDir();
  const cwd = await tempDir();
  const { stdout } = await update(cwd, home, ['--scope', 'user']);
  const folder = join(home, '.claude', 'skills');
  await assertInstalled(folder);
  assert.match(stdout, new RegExp(`wrote ${join(folder, 'create-issue')}\n`));
  assert.match(stdout, new RegExp(`wrote ${join(folder, 'answer-hand-over')}\n`));
});

test('a user who runs update --scope project in a linked worktree gets the skills in .claude/skills of the main worktree', async () => {
  const home = await tempDir();
  const { root, linked } = await linkedWorktree();
  await update(linked, home, ['--scope', 'project']);
  await assertInstalled(join(root, '.claude', 'skills'));
  assert.deepEqual(await readdir(home), []);
});

test('a user who runs update over older copies gets them replaced and keeps their other skills', async () => {
  const home = await tempDir();
  const folder = join(home, '.claude', 'skills');
  await mkdir(join(folder, 'create-issue'), { recursive: true });
  await writeFile(join(folder, 'create-issue', 'SKILL.md'), 'old');
  await writeFile(join(folder, 'create-issue', 'old.md'), 'old');
  await mkdir(join(folder, 'mine'));
  await writeFile(join(folder, 'mine', 'SKILL.md'), 'mine');
  await update(await tempDir(), home, ['--scope', 'user']);
  await assertInstalled(folder);
  assert.deepEqual((await readdir(join(folder, 'create-issue'))).sort(), [
    'SKILL.md',
    'template.md',
  ]);
  assert.equal(await readFile(join(folder, 'mine', 'SKILL.md'), 'utf8'), 'mine');
});

test('a user who runs update with no --scope and no terminal gets an error that names --scope, exit code 1 and no skill written', async () => {
  const home = await tempDir();
  const { root } = await linkedWorktree();
  await assert.rejects(update(root, home, []), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--scope user\|project/);
    return true;
  });
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual((await readdir(root)).sort(), ['.git', '.worktrees']);
});

test('a user who runs update --scope project outside a git repository gets exit code 1 and no skill written', async () => {
  const home = await tempDir();
  const cwd = await tempDir();
  await assert.rejects(update(cwd, home, ['--scope', 'project']), (error: { code: number }) => {
    assert.equal(error.code, 1);
    return true;
  });
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(cwd), []);
});

test('a user who runs update in a terminal with no --scope is asked where to install the skills and gets them in the folder they answer', async () => {
  for (const answer of ['user', 'u', 'project', 'p']) {
    const home = await tempDir();
    const { root } = await linkedWorktree();
    const { stdout } = await updateInTerminal(root, home, `${answer}\n`);
    assert.match(stdout, /~\/\.claude\/skills/);
    assert.match(stdout, /\.claude\/skills of the main worktree/);
    const base = answer.startsWith('u') ? home : root;
    await assertInstalled(join(base, '.claude', 'skills'));
  }
});

test('a user who runs update in a terminal and gives another answer than user or project gets an error that names them, exit code 1 and no skill written', async () => {
  const home = await tempDir();
  const { root } = await linkedWorktree();
  await assert.rejects(
    updateInTerminal(root, home, 'both\n'),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /answer user or project/);
      return true;
    },
  );
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual((await readdir(root)).sort(), ['.git', '.worktrees']);
});
