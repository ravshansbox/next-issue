import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { linkedWorktree, repository } from './helpers.mts';
import { tempDir } from './temp-dir.mts';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const TERMINAL_STDIN = '--import=data:text/javascript,process.stdin.isTTY=true';
const FULL_DISK = `--import=data:text/javascript,${encodeURIComponent(
  "import fs from 'node:fs/promises';import { syncBuiltinESMExports } from 'node:module';fs.cp = async (source, destination) => { await fs.mkdir(destination, { recursive: true }); await fs.writeFile(destination + '/SKILL.md', 'half'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };syncBuiltinESMExports();",
)}`;

function init(cwd: string, home: string, args: string[]) {
  return promisify(execFile)(process.execPath, [CLI, 'init', ...args], {
    cwd,
    env: { ...process.env, HOME: home },
  });
}

function initOnFullDisk(cwd: string, home: string, args: string[]) {
  return promisify(execFile)(process.execPath, [FULL_DISK, CLI, 'init', ...args], {
    cwd,
    env: { ...process.env, HOME: home },
  });
}

function initInTerminal(cwd: string, home: string, answer: string) {
  const child = promisify(execFile)(process.execPath, [TERMINAL_STDIN, CLI, 'init'], {
    cwd,
    env: { ...process.env, HOME: home },
  });
  child.child.stdin?.end(answer);
  return child;
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

async function untouched(root: string, home: string): Promise<void> {
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual((await readdir(root)).sort(), ['.git', '.worktrees']);
  assert.doesNotMatch(await readFile(join(root, '.git/info/exclude'), 'utf8'), /\.next-issue\//);
}

test('a user who runs init --scope user gets the config file, the exclude lines and the skills in ~/.claude/skills, with output that names each', async () => {
  const home = await tempDir();
  const root = await repository();
  const { stdout } = await init(root, home, ['--scope', 'user']);
  const folder = join(home, '.claude', 'skills');
  await assertInstalled(folder);
  assert.match(stdout, /wrote .*\.next-issue\/config\.json\n/);
  assert.match(stdout, /added \.next-issue\/ to .*info\/exclude/);
  assert.match(stdout, new RegExp(`wrote ${join(folder, 'create-issue')}\n`));
  assert.match(stdout, new RegExp(`wrote ${join(folder, 'answer-hand-over')}\n`));
});

test('a user who runs init --scope project in a linked worktree gets the skills in .claude/skills of the main worktree', async () => {
  const home = await tempDir();
  const root = await repository();
  const linked = await linkedWorktree(root);
  await init(linked, home, ['--scope', 'project']);
  await assertInstalled(join(root, '.claude', 'skills'));
  assert.deepEqual(await readdir(home), []);
});

test('a user who runs init with a config file there already keeps the file, sees kept with its path, gets the skills and the exclude lines, and exit code 0', async () => {
  const home = await tempDir();
  const root = await repository();
  await mkdir(join(root, '.next-issue'));
  await writeFile(join(root, '.next-issue/config.json'), '{ "maxCiFixes": 9 }\n');
  const { stdout } = await init(root, home, ['--scope', 'user']);
  assert.equal(
    await readFile(join(root, '.next-issue/config.json'), 'utf8'),
    '{ "maxCiFixes": 9 }\n',
  );
  assert.match(stdout, new RegExp(`kept ${join(root, '.next-issue/config.json')}\n`));
  assert.match(stdout, /added \.next-issue\/ to .*info\/exclude/);
  await assertInstalled(join(home, '.claude', 'skills'));
});

test('a user who runs init --force with a config file there gets the defaults in it and the skills', async () => {
  const home = await tempDir();
  const root = await repository();
  await mkdir(join(root, '.next-issue'));
  await writeFile(join(root, '.next-issue/config.json'), '{ "maxCiFixes": 9 }\n');
  await init(root, home, ['--scope', 'user', '--force']);
  assert.equal(
    JSON.parse(await readFile(join(root, '.next-issue/config.json'), 'utf8')).maxCiFixes,
    5,
  );
  await assertInstalled(join(home, '.claude', 'skills'));
});

test('a user who runs init over older copies of the skills gets them replaced and keeps their other skills', async () => {
  const home = await tempDir();
  const folder = join(home, '.claude', 'skills');
  await mkdir(join(folder, 'create-issue'), { recursive: true });
  await writeFile(join(folder, 'create-issue', 'SKILL.md'), 'old');
  await writeFile(join(folder, 'create-issue', 'old.md'), 'old');
  await mkdir(join(folder, 'mine'));
  await writeFile(join(folder, 'mine', 'SKILL.md'), 'mine');
  await init(await repository(), home, ['--scope', 'user']);
  await assertInstalled(folder);
  assert.deepEqual((await readdir(join(folder, 'create-issue'))).sort(), [
    'SKILL.md',
    'template.md',
  ]);
  assert.equal(await readFile(join(folder, 'mine', 'SKILL.md'), 'utf8'), 'mine');
  assert.deepEqual((await readdir(folder)).sort(), ['answer-hand-over', 'create-issue', 'mine']);
});

test('a user who runs init when the skill copy fails part way keeps the skill installed before, has no half-written copy left and gets an error and exit code 1', async () => {
  const home = await tempDir();
  const folder = join(home, '.claude', 'skills');
  await mkdir(join(folder, 'create-issue'), { recursive: true });
  await writeFile(join(folder, 'create-issue', 'SKILL.md'), 'old');
  await assert.rejects(
    initOnFullDisk(await repository(), home, ['--scope', 'user']),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^ENOSPC/m);
      return true;
    },
  );
  assert.deepEqual(await readdir(folder), ['create-issue']);
  assert.deepEqual(await readdir(join(folder, 'create-issue')), ['SKILL.md']);
  assert.equal(await readFile(join(folder, 'create-issue', 'SKILL.md'), 'utf8'), 'old');
});

test('a user who runs init with no --scope and no terminal gets an error that names init and --scope, exit code 1 and nothing written', async () => {
  const home = await tempDir();
  const root = await repository();
  await linkedWorktree(root);
  await assert.rejects(init(root, home, []), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /`init` needs `--scope user\|project`/);
    return true;
  });
  await untouched(root, home);
});

test('a user who runs init in a terminal with no --scope is asked where to install the skills and gets them in the folder they answer', async () => {
  for (const answer of ['user', 'u', 'project', 'p']) {
    const home = await tempDir();
    const root = await repository();
    await linkedWorktree(root);
    const { stdout } = await initInTerminal(root, home, `${answer}\n`);
    assert.match(stdout, /~\/\.claude\/skills/);
    assert.match(stdout, /\.claude\/skills of the main worktree/);
    const base = answer.startsWith('u') ? home : root;
    await assertInstalled(join(base, '.claude', 'skills'));
  }
});

test('a user who runs init in a terminal and gives another answer than user or project gets an error that names them, exit code 1 and nothing written', async () => {
  const home = await tempDir();
  const root = await repository();
  await linkedWorktree(root);
  await assert.rejects(
    initInTerminal(root, home, 'both\n'),
    (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /answer user or project/);
      return true;
    },
  );
  await untouched(root, home);
});
