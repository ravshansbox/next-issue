import { runAgent } from './agents.mts';
import { run } from './exec.mts';
import {
  abortMerge,
  addWorktree,
  commitAll,
  commitMerge,
  deleteBranch,
  diff,
  discardChanges,
  disputeBranches,
  findWorktree,
  isDirty,
  latestSubject,
  push,
  removeWorktree,
  resetToBase,
  revision,
  setAside,
  startMerge,
} from './git.mts';
import {
  canWrite,
  commentOnIssue,
  commentOnPr,
  createPr,
  findPr,
  issueComments,
  markPrReady,
  mergeCommit,
  mergePr,
  openBlockers,
  openIssues,
  prConflicts,
  prMerged,
  reopenIssue,
  threadComments,
  viewIssue,
} from './github.mts';
import { failedBaseLogs, failedCheckLogs, waitForBaseChecks, waitForChecks } from './checks.mts';
import { setLabel } from './labels.mts';
import { detectSetupCommand } from './setup.mts';

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
