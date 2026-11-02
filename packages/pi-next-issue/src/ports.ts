import * as agent from './agent.ts';
import type { Config } from './config.ts';
import * as git from './git.ts';
import * as github from './github.ts';
import type { Ports } from './runner.ts';
import * as state from './state.ts';

export async function createPorts(root: string, config: Config): Promise<Ports> {
  const repo: github.Repo = { root, slug: await git.remoteSlug(root, config.remote) };
  const base = await github.defaultBranch(repo);
  const timeoutMs = config.checkTimeoutMinutes * 60_000;
  return {
    openIssues: async () => {
      const { open, closed } = await github.openIssues(repo, await state.savedIssues(root));
      await Promise.all(closed.map((issue) => state.dropState(root, issue)));
      return open;
    },
    comments: (issue) => github.comments(repo, issue),
    setLabel: (issue, add, remove) => github.setLabel(repo, issue, add, remove),
    commentOnIssue: (issue, body) => github.commentOnIssue(repo, issue, body),
    worktree: (issue, branch) => git.worktree(root, config.remote, base, issue, branch),
    commit: (cwd, message) => git.commit(cwd, message),
    ahead: (cwd) => git.ahead(cwd, config.remote, base),
    push: (cwd, branch) => git.push(cwd, config.remote, branch),
    discard: (cwd, branch) => git.discard(cwd, config.remote, branch),
    diff: (cwd) => git.diff(cwd, config.remote, base),
    openPr: (branch, title, body) => github.openPr(repo, branch, base, title, body),
    checks: async (pr, cwd, signal) =>
      github.checks(repo, pr, await git.head(cwd), timeoutMs, signal),
    failedLogs: (pr) => github.failedLogs(repo, pr, config.logMaxChars),
    commentOnPr: (pr, body) => github.commentOnPr(repo, pr, body),
    merge: (pr, signal) => github.merge(repo, pr, timeoutMs, signal),
    cleanup: (_issue, branch, cwd) => git.cleanup(root, config.remote, branch, cwd),
    work: agent.work,
    review: agent.review,
    readState: (issue) => state.readState(root, issue),
    writeState: (value) => state.writeState(root, value),
    dropState: (issue) => state.dropState(root, issue),
    savedIssues: () => state.savedIssues(root),
    lock: () => state.lock(root),
    unlock: () => state.unlock(root),
  };
}
