import { lines, must, run } from './exec.mts';

export type Repo = {
  owner: string;
  name: string;
  root: string;
};

const REMOTE_PATTERNS = [
  /^git@[^:]+:(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^ssh:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
  /^https?:\/\/[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?$/,
];

export function parseRemote(url: string): { owner: string; name: string } {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (match?.groups) {
      return { owner: match.groups.owner!, name: match.groups.name! };
    }
  }
  throw new Error(`Cannot parse the git remote URL: ${url}`);
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export async function detectRepo(cwd: string, remote: string): Promise<Repo> {
  const root = await repoRoot(cwd);
  const url = await git(cwd, ['remote', 'get-url', remote]);
  const { owner, name } = parseRemote(url);
  return { owner, name, root };
}

export function remoteRef(remote: string, branch: string): string {
  return `${remote}/${branch}`;
}

export function branchName(issue: number): string {
  return String(issue);
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  return status.length > 0;
}

export async function diff(cwd: string, base: string, remote: string): Promise<string> {
  return git(cwd, ['diff', `${remoteRef(remote, base)}...HEAD`]);
}

export async function discardChanges(cwd: string, target: string): Promise<boolean> {
  if (!(await isDirty(cwd)) && (await revision(cwd)) === target) {
    return false;
  }
  await resetHard(cwd, target);
  return true;
}

export async function resetHard(cwd: string, target: string): Promise<void> {
  await git(cwd, ['reset', '--hard', target]);
  await git(cwd, ['clean', '-fd']);
}

export async function setAside(cwd: string, target: string, branch: string): Promise<void> {
  await git(cwd, ['branch', branch]);
  if (await isDirty(cwd)) {
    await git(cwd, ['reset', '--soft', target]);
    return;
  }
  await discardChanges(cwd, target);
}

export async function disputeBranches(repo: Repo, branch: string): Promise<string[]> {
  const list = await git(repo.root, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${branch}-dispute-*`,
  ]);
  return lines(list);
}

export async function push(
  cwd: string,
  remote: string,
  branch: string,
  force = false,
): Promise<void> {
  await git(cwd, ['push', '-u', ...(force ? ['--force'] : []), remote, branch]);
}

export async function fetchBase(cwd: string, base: string, remote: string): Promise<string> {
  await git(cwd, ['fetch', remote, base]);
  return remoteRef(remote, base);
}

export async function resetToBase(cwd: string, base: string, remote: string): Promise<void> {
  const target = await fetchBase(cwd, base, remote);
  await git(cwd, ['reset', '--hard', target]);
}

export async function latestSubject(
  cwd: string,
  base: string,
  remote: string,
): Promise<string | undefined> {
  const subject = await git(cwd, ['log', '-1', '--format=%s', `${remoteRef(remote, base)}..HEAD`]);
  return subject === '' ? undefined : subject;
}

export async function revision(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return succeeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

export async function deleteBranch(repo: Repo, branch: string): Promise<boolean> {
  return succeeds(repo.root, ['branch', '-D', branch]);
}

export async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await run('git', args, { cwd });
  return result.code === 0;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return must('git', args, { cwd });
}
