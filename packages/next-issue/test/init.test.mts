import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { git } from './clones.mts';
import { baseGh } from './fake-gh.mts';
import {
  linkedWorktree,
  oldWorktrees,
  pushPackage,
  pushScripts,
  repository,
  writeScripts,
} from './helpers.mts';
import { tempDir } from './temp-dir.mts';

const ORIGIN = 'git@github.com:acme/init.git';

await baseGh();

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
  assert.deepEqual((await readdir(root)).sort(), ['.claude', '.git', 'package.json']);
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

test('a user whose base on origin lacks scripts that the main worktree has runs init and gets the config file and the skills, then exit code 1 and an error that names the base, each missing script and why', async () => {
  const home = await tempDir();
  const root = await repository(ORIGIN);
  await pushScripts(root, ['format', 'test']);
  await assert.rejects(
    init(root, home, ['--scope', 'user']),
    (error: { code: number; stdout: string; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /wrote .*\.next-issue\/config\.json\n/);
      assert.match(
        error.stderr,
        /the package\.json on `origin\/main` lacks the scripts `lint` and `typecheck`\./,
      );
      assert.match(error.stderr, /instead of a person/);
      assert.match(error.stderr, /`format` must check the formatting, not write files/);
      return true;
    },
  );
  await assertInstalled(join(home, '.claude', 'skills'));
});

test('a user whose package.json on the base on origin is not valid JSON runs init and gets the config file and the skills, then exit code 1 and an error that names the parse error', async () => {
  const home = await tempDir();
  const root = await repository(ORIGIN);
  await pushPackage(root, '{ "scripts": ');
  await assert.rejects(
    init(root, home, ['--scope', 'user']),
    (error: { code: number; stdout: string; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /wrote .*\.next-issue\/config\.json\n/);
      assert.match(error.stderr, /the package\.json on `origin\/main` is not valid JSON: /);
      return true;
    },
  );
  await assertInstalled(join(home, '.claude', 'skills'));
});

test('a user whose base on origin has all four scripts but whose main worktree lacks some runs init and sees exit code 0 and no error', async () => {
  const home = await tempDir();
  const root = await repository(ORIGIN);
  await writeScripts(root, ['format']);
  const { stderr } = await init(root, home, ['--scope', 'user']);
  assert.equal(stderr, '');
});

test('a user who runs init in a repository with no remote gets the config file and the skills, a note that the scripts on the base could not be checked and exit code 0', async () => {
  const home = await tempDir();
  const root = await repository();
  const { stdout, stderr } = await init(root, home, ['--scope', 'user']);
  assert.match(stdout, /wrote .*\.next-issue\/config\.json\n/);
  assert.match(stderr, /^could not check the scripts on the base branch: .*origin/);
  await assertInstalled(join(home, '.claude', 'skills'));
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

test('a user who runs init with worktrees an older next-issue left in .worktrees sees each removed and named, the folder gone, branch 7 kept and its uncommitted file on a 7-detached branch', async () => {
  const home = await tempDir();
  const root = await repository();
  const { hunt, issue } = await oldWorktrees(root);
  const branch = await git(root, 'rev-parse', '7');
  const { stdout } = await init(root, home, ['--scope', 'user']);
  assert.ok(stdout.includes(`removed old worktree ${hunt}\n`));
  assert.ok(stdout.includes(`removed old worktree ${issue}\n`));
  assert.equal(existsSync(join(root, '.worktrees')), false);
  assert.equal(await git(root, 'rev-parse', '7'), branch);
  const kept = await git(root, 'branch', '--list', '7-detached-*', '--format=%(refname:short)');
  assert.match(kept, /^7-detached-[0-9a-f]{7}$/);
  assert.equal(await git(root, 'show', `${kept}:work.txt`), 'work');
});

test('a user who runs init with a locked old worktree in .worktrees sees it named as not removed, the other one removed and the folder kept', async () => {
  const home = await tempDir();
  const root = await repository();
  const { hunt, issue } = await oldWorktrees(root);
  await git(root, 'worktree', 'lock', issue);
  const { stdout } = await init(root, home, ['--scope', 'user']);
  assert.ok(stdout.includes(`could not remove ${issue}: `));
  assert.ok(stdout.includes(`removed old worktree ${hunt}\n`));
  assert.equal(existsSync(issue), true);
  assert.equal(existsSync(hunt), false);
});

test('a user who runs init with no .worktrees folder sees no old worktree named', async () => {
  const home = await tempDir();
  const root = await repository();
  const { stdout } = await init(root, home, ['--scope', 'user']);
  assert.doesNotMatch(stdout, /old worktree/);
});
