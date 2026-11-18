import { cp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Scope } from '../shared/args.mts';
import { OWN_SKILLS } from '../shared/agents.mts';
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
      'update needs --scope user|project when there is no terminal to ask where to install the skills',
    );
  }
  return askScope(process.stdin, process.stdout);
}

async function skillsFolder(scope: Scope): Promise<string> {
  const base = scope === 'user' ? homedir() : await repoRoot(process.cwd());
  return join(base, '.claude', 'skills');
}

export async function installSkills(scope: Scope): Promise<string[]> {
  const folder = await skillsFolder(scope);
  const written: string[] = [];
  for (const name of OWN_SKILLS) {
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
    written.push(target);
  }
  return written;
}
