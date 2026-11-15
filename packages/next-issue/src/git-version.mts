import { must } from './exec.mts';

// `git hook run` (every commit) needs 2.36, `git check-attr --source` (every conflict) needs 2.40.
export const MIN_GIT: readonly [number, number] = [2, 40];

export function gitVersionError(output: string): string | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
  if (match === null) {
    return `cannot read the git version from "${output.trim()}"`;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [needMajor, needMinor] = MIN_GIT;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) {
    return undefined;
  }
  const found = match[3] === undefined ? `${major}.${minor}` : `${major}.${minor}.${match[3]}`;
  return `git ${found} is too old: next-issue needs git ${needMajor}.${needMinor} or later`;
}

export async function checkGitVersion(): Promise<void> {
  const error = gitVersionError(await must('git', ['--version']));
  if (error !== undefined) {
    throw new Error(error);
  }
}
