import { runAgent } from './agents.mts';
import { failedBaseLogs, rerunFailedBase, waitForBaseChecks } from './base-checks.mts';
import { run } from './exec.mts';
import { commitAll } from './git-commit.mts';
import { pushToBase, revertOnBase, squashOnto } from './git-land.mts';
import { abortMerge, commitMerge, startMerge } from './git-merge.mts';
import {
  deleteBranch,
  diff,
  discardChanges,
  disputeBranches,
  isDirty,
  latestSubject,
  push,
  resetToBase,
  revision,
  setAside,
} from './git.mts';
import {
  canWrite,
  closeIssue,
  commentOnIssue,
  issueComments,
  openBlockers,
  openIssues,
  reopenIssue,
  threadComments,
  viewIssue,
} from './github.mts';
import { setLabel } from './labels.mts';
import { detectSetupCommand } from './setup.mts';
import { addWorktree, findWorktree, removeWorktree } from './worktree.mts';

export type SetupResult = { code: number; stderr: string; timedOut?: boolean };

async function runSetup(command: string, cwd: string, timeoutMs: number): Promise<SetupResult> {
  return run('bash', ['-lc', command], { cwd, timeoutMs });
}

export const PORTS = {
  abortMerge,
  addWorktree,
  canWrite,
  closeIssue,
  commentOnIssue,
  commitAll,
  commitMerge,
  deleteBranch,
  detectSetupCommand,
  diff,
  discardChanges,
  disputeBranches,
  failedBaseLogs,
  findWorktree,
  isDirty,
  issueComments,
  latestSubject,
  openBlockers,
  openIssues,
  push,
  pushToBase,
  removeWorktree,
  reopenIssue,
  rerunFailedBase,
  resetToBase,
  revertOnBase,
  revision,
  runAgent,
  runSetup,
  setAside,
  setLabel,
  squashOnto,
  startMerge,
  threadComments,
  viewIssue,
  waitForBaseChecks,
};

export type Ports = typeof PORTS;
