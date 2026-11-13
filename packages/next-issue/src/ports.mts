import { runAgent } from './agents.mts';
import { failedBaseLogs, waitForBaseChecks } from './base-checks.mts';
import { failedCheckLogs, waitForChecks } from './checks.mts';
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
  commentOnPr,
  issueComments,
  openBlockers,
  openIssues,
  reopenIssue,
  threadComments,
  viewIssue,
} from './github.mts';
import { setLabel } from './labels.mts';
import {
  createPr,
  findPr,
  markPrReady,
  mergeCommit,
  mergePr,
  prConflicts,
  prMerged,
} from './pull-requests.mts';
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
  commentOnPr,
  commitAll,
  commitMerge,
  createPr,
  deleteBranch,
  detectSetupCommand,
  diff,
  discardChanges,
  disputeBranches,
  failedBaseLogs,
  failedCheckLogs,
  findPr,
  findWorktree,
  isDirty,
  issueComments,
  latestSubject,
  markPrReady,
  mergeCommit,
  mergePr,
  openBlockers,
  openIssues,
  prConflicts,
  prMerged,
  push,
  pushToBase,
  removeWorktree,
  reopenIssue,
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
  waitForChecks,
};

export type Ports = typeof PORTS;
