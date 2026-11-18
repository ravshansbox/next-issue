import { must, run, succeeded } from './exec.mts';
import { oneAtATime } from './lock.mts';
import { lines } from './text.mts';

export type Repo = {
  host?: string;
  owner: string;
  name: string;
  root: string;
};

const REMOTE_PATTERNS = [
  /^(?:[^@/:]+@)?(?<host>[^@/:]+):(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/(?:[^@/]+@)?(?<host>[^@/:]+)(?::\d+)?\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
  /^https?:\/\/(?:[^@/]+@)?(?<host>[^@/:]+)(?::\d+)?\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
];

const GITHUB_SSH_HOST = 'ssh.github.com';

function githubHost(host: string): string {
  const lower = host.toLowerCase();
  return lower === GITHUB_SSH_HOST ? 'github.com' : lower;
}

export type Remote = { host: string; owner: string; name: string };

export function parseRemote(url: string): Remote {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (match?.groups) {
      return {
        host: githubHost(match.groups.host!),
        owner: match.groups.owner!,
        name: match.groups.name!,
      };
    }
  }
  throw new Error(`Cannot parse the git remote URL: ${url}`);
}

async function sshHost(url: string, host: string): Promise<string> {
  if (host === 'github.com' || /^https?:/.test(url.trim())) {
    return host;
  }
  const result = await run('ssh', ['-G', '--', host]).catch(() => undefined);
  const resolved = /^hostname[^\S\r\n]+(\S+)$/m.exec(result?.stdout ?? '')?.[1];
  return result !== undefined && succeeded(result) && resolved !== undefined
    ? githubHost(resolved)
    : host;
}

export async function repoRoot(cwd: string): Promise<string> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  const list = await git(cwd, ['worktree', 'list', '--porcelain']);
  const [first = '', second = ''] = list.split('\n');
  return first.startsWith('worktree ') && second !== 'bare' ? first.slice('worktree '.length) : top;
}

export async function detectRepo(cwd: string, remote: string): Promise<Repo> {
  const root = await repoRoot(cwd);
  const url = await git(cwd, ['remote', 'get-url', remote]);
  const { host, owner, name } = parseRemote(url);
  return { host: await sshHost(url, host), owner, name, root };
}

export function remoteRef(remote: string, branch: string): string {
  return `${remote}/${branch}`;
}

export function branchName(issue: number): string {
  return String(issue);
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  return status.length > 0;
}

export async function diff(cwd: string, base: string, remote: string): Promise<string> {
  return git(cwd, ['diff', `${remoteRef(remote, base)}...HEAD`]);
}

/** The files that the commits added or changed, as paths from the repository root. */
export async function changedFiles(cwd: string, shas: string[]): Promise<string[]> {
  if (shas.length === 0) {
    return [];
  }
  const output = await git(cwd, [
    'show',
    '--no-renames',
    '--diff-filter=d',
    '--name-only',
    '-z',
    '--format=',
    ...shas,
  ]);
  return [
    ...new Set(
      output
        .split('\0')
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
}

export async function discardChanges(
  cwd: string,
  target: string,
  branch?: string,
): Promise<boolean> {
  const moved = branch !== undefined && (await currentBranch(cwd)) !== branch;
  if (
    !moved &&
    !(await isDirty(cwd)) &&
    !(await succeeds(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])) &&
    (await revision(cwd)) === target
  ) {
    return false;
  }
  if (moved) {
    await git(cwd, ['checkout', '--force', '-B', branch, target]);
  }
  await resetHard(cwd, target);
  return true;
}

export async function resetHard(cwd: string, target: string): Promise<void> {
  await git(cwd, ['reset', '--hard', target]);
  await git(cwd, ['clean', '-fd']);
}

/** Commits every edit in the worktree, with no hooks, so a later checkout cannot throw it away. */
export async function saveEdits(cwd: string, commitMessage: string): Promise<boolean> {
  if (!(await isDirty(cwd))) {
    return false;
  }
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--no-verify', '-m', commitMessage]);
  return true;
}

/** Commits what the setup wrote on top of the change, with no hooks, so every check sees it. */
export async function saveSetupOutput(cwd: string): Promise<void> {
  await saveEdits(cwd, 'chore: setup output');
}

export async function setAside(cwd: string, target: string, branch: string): Promise<void> {
  await git(cwd, ['branch', branch]);
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

export async function fetchBase(cwd: string, base: string, remote: string): Promise<string> {
  await gitFetch(cwd, [remote, base]);
  return remoteRef(remote, base);
}

export function oneFetchAtATime<T>(work: () => Promise<T>): Promise<T> {
  return oneAtATime('git fetch', work);
}

export function gitFetch(cwd: string, args: string[]): Promise<string> {
  return oneFetchAtATime(() => git(cwd, ['fetch', ...args]));
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
  return succeeded(result) ? result.stdout.trim() : undefined;
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return succeeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

export async function isLanded(cwd: string, base: string, remote: string): Promise<boolean> {
  return isAncestor(cwd, 'HEAD', remoteRef(remote, base));
}

export async function isOnBase(
  cwd: string,
  base: string,
  remote: string,
  sha: string,
): Promise<boolean> {
  return isAncestor(cwd, sha, await fetchBase(cwd, base, remote));
}

export async function deleteBranch(repo: Repo, branch: string): Promise<boolean> {
  return succeeds(repo.root, ['branch', '-D', branch]);
}

export async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return succeeded(await run('git', args, { cwd }));
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return must('git', args, { cwd });
}
