import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Scope } from '../shared/args.mts';
import { OWN_SKILLS } from '../shared/agents.mts';
import { hasCode } from '../shared/errors.mts';
import { repoRoot } from '../shared/git.mts';

const SKILLS = join(import.meta.dirname, '..', '..', 'skills');

const QUESTION =
  'Install the skills for the user, in ~/.claude/skills, or for the project, in .claude/skills of the main worktree? (user/project) ';

const ANSWERS = new Map<string, Scope>([
  ['user', 'user'],
  ['u', 'user'],
  ['project', 'project'],
  ['p', 'project'],
]);

async function askScope(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<Scope> {
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(QUESTION)).trim().toLowerCase();
    const scope = ANSWERS.get(answer);
    if (scope === undefined) {
      throw new Error(`answer user or project, not ${JSON.stringify(answer)}`);
    }
    return scope;
  } finally {
    prompt.close();
  }
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
  return askScope(process.stdin, process.stdout);
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

export async function refreshSkills(root: string): Promise<string[]> {
  const folders = [
    ...new Set([join(homedir(), '.claude', 'skills'), join(root, '.claude', 'skills')]),
  ];
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
      if (hash !== shipped) {
        notes.push(`updated ${await replaceSkill(folder, name)}`);
      }
    }
    if (!installed) {
      notes.push(`wrote ${await replaceSkill(join(root, '.claude', 'skills'), name)}`);
    }
  }
  return notes;
}
