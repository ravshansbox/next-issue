import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Scope } from '../shared/args.mts';
import { OWN_SKILLS } from '../shared/agents.mts';
import { hasCode } from '../shared/errors.mts';
import { git, repoRoot } from '../shared/git.mts';

const SKILLS = join(import.meta.dirname, '..', '..', 'skills');

export const PROJECT_SKILL_FOLDERS = OWN_SKILLS.map((name) => `.claude/skills/${name}/`);

const QUESTION =
  'Install the skills for the user, in ~/.claude/skills, or for the project, in .claude/skills of the main worktree? (user/project) ';

const ANSWERS = new Map<string, Scope>([
  ['user', 'user'],
  ['u', 'user'],
  ['project', 'project'],
  ['p', 'project'],
]);

async function ask(question: string, output: NodeJS.WritableStream): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output });
  try {
    return (await prompt.question(question)).trim().toLowerCase();
  } finally {
    prompt.close();
  }
}

async function askScope(): Promise<Scope> {
  const answer = await ask(QUESTION, process.stdout);
  const scope = ANSWERS.get(answer);
  if (scope === undefined) {
    throw new Error(`answer user or project, not ${JSON.stringify(answer)}`);
  }
  return scope;
}

export async function chooseScope(scope: Scope | undefined): Promise<Scope> {
  if (scope !== undefined) {
    return scope;
  }
  if (process.stdin.isTTY !== true) {
    throw new Error(
      '`init` needs `--scope user|project` when there is no terminal to ask where to install the skills',
    );
  }
  return askScope();
}

async function skillsFolder(scope: Scope): Promise<string> {
  const base = scope === 'user' ? homedir() : await repoRoot(process.cwd());
  return join(base, '.claude', 'skills');
}

async function replaceSkill(folder: string, name: string): Promise<string> {
  const target = join(folder, name);
  const staging = join(folder, `.${name}.new`);
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(join(SKILLS, name), staging, { recursive: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  return target;
}

export async function installSkills(scope: Scope): Promise<string[]> {
  const folder = await skillsFolder(scope);
  const written: string[] = [];
  for (const name of OWN_SKILLS) {
    written.push(await replaceSkill(folder, name));
  }
  return written;
}

async function skillHash(folder: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.slice(folder.length)}\0`);
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function isOwnSkill(folder: string): Promise<boolean> {
  let text;
  try {
    text = await readFile(join(folder, 'SKILL.md'), 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return frontmatter
    .split(/\r?\n/)
    .some((line) => line.startsWith('description:') && line.includes('next-issue'));
}

async function isTracked(root: string, folder: string): Promise<boolean> {
  return (await git(root, ['ls-files', '--', folder])) !== '';
}

export async function refreshSkills(root: string): Promise<string[]> {
  const project = join(root, '.claude', 'skills');
  const folders = [...new Set([join(homedir(), '.claude', 'skills'), project])];
  const notes: string[] = [];
  for (const name of OWN_SKILLS) {
    const shipped = await skillHash(join(SKILLS, name));
    let installed = false;
    for (const folder of folders) {
      const hash = await skillHash(join(folder, name));
      if (hash === undefined) {
        continue;
      }
      installed = true;
      if (hash === shipped) {
        continue;
      }
      if (await isOwnSkill(join(folder, name))) {
        notes.push(`updated ${await replaceSkill(folder, name)}`);
      } else {
        notes.push(`kept ${join(folder, name)}: not a next-issue skill`);
      }
    }
    if (!installed) {
      notes.push(`wrote ${await replaceSkill(project, name)}`);
    }
  }
  return notes;
}

export async function untrackSkills(root: string): Promise<string[]> {
  const folders: string[] = [];
  for (const folder of PROJECT_SKILL_FOLDERS) {
    if ((await isTracked(root, folder)) && (await isOwnSkill(join(root, folder)))) {
      folders.push(folder);
    }
  }
  if (folders.length === 0) {
    return [];
  }
  const tracked = `git tracks the next-issue skills in ${folders.join(', ')}`;
  const untrack = `git rm -r --cached -- ${folders.join(' ')}`;
  if (process.stdin.isTTY !== true) {
    throw new Error(
      `${tracked}; untrack them in ${root} with \`${untrack}\`, commit and push the removal, and run \`npx -y next-issue@latest start\` again`,
    );
  }
  const answer = await ask(`${tracked}. Untrack them? (y/n) `, process.stderr);
  if (answer !== 'y' && answer !== 'yes') {
    throw new Error(`${tracked}; \`npx -y next-issue@latest start\` needs them untracked`);
  }
  const committed =
    (await git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...folders])) !== '';
  await git(root, ['rm', '-r', '-q', '--cached', '-f', '--ignore-unmatch', '--', ...folders]);
  return [
    committed
      ? `untracked ${folders.join(', ')} (staged); commit and push the removal`
      : `untracked ${folders.join(', ')}`,
  ];
}
