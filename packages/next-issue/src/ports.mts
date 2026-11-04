import { runAgent } from './agents.mts';
import { run } from './exec.mts';
import {
  commitAll,
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
  commentOnIssue,
  commentOnPr,
  issueComments,
  openBlockers,
  openIssues,
  reopenIssue,
  threadComments,
  viewIssue,
} from './github.mts';
import {
  createPr,
  findPr,
  markPrReady,
  mergeCommit,
  mergePr,
  prConflicts,
  prMerged,
} from './pull-requests.mts';
import { abortMerge, commitMerge, startMerge } from './git-merge.mts';
import { failedBaseLogs, waitForBaseChecks } from './base-checks.mts';
import { failedCheckLogs, waitForChecks } from './checks.mts';
import { setLabel } from './labels.mts';
import { detectSetupCommand } from './setup.mts';
import { addWorktree, findWorktree, removeWorktree } from './worktree.mts';

async function runSetup(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timedOut?: boolean }> {
  return run('bash', ['-lc', command], { cwd, timeoutMs });
}

export const PORTS = {
  abortMerge,
  addWorktree,
  canWrite,
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
  removeWorktree,
  reopenIssue,
  resetToBase,
  revision,
  runAgent,
  runSetup,
  setAside,
  setLabel,
  startMerge,
  threadComments,
  viewIssue,
  waitForBaseChecks,
  waitForChecks,
};

export type Ports = typeof PORTS;
