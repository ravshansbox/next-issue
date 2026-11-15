import { runAgent } from './agents.mts';
import { failedBaseLogs, rerunFailedBase, waitForBaseChecks } from './base-checks.mts';
import { run } from './exec.mts';
import { commitAll } from './git-commit.mts';
import { pushToBase, reapplyRevert, revertOnBase, squashOnto } from './git-land.mts';
import { abortMerge, commitMerge, startMerge } from './git-merge.mts';
import {
  deleteBranch,
  diff,
  discardChanges,
  disputeBranches,
  isDirty,
  isLanded,
  isOnBase,
  latestSubject,
  push,
  resetToBase,
  revision,
  saveEdits,
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
  repositorySlug,
  threadComments,
  viewIssue,
} from './github.mts';
import { huntWorktree } from './hunt.mts';
import { ensureLabel, setLabel } from './labels.mts';
import { detectSetupCommand } from './setup.mts';
import { addWorktree, fastForwardBase, findWorktree, removeWorktree } from './worktree.mts';

export type SetupResult = { code: number; stderr: string; timedOut?: boolean };

async function runSetup(command: string, cwd: string, timeoutMs: number): Promise<SetupResult> {
  return run('bash', ['-lc', command], { cwd, timeoutMs });
}

export type CheckResult = { code: number; output: string; timedOut: boolean };

/** Runs a check command with its stderr in its stdout, so the output keeps the order it was written in. */
async function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
  tailChars?: number,
): Promise<CheckResult> {
  const result = await run('bash', ['-lc', `exec 2>&1\n${command}`], { cwd, timeoutMs, tailChars });
  return { code: result.code, output: result.stdout, timedOut: result.timedOut };
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
  ensureLabel,
  failedBaseLogs,
  fastForwardBase,
  findWorktree,
  huntWorktree,
  isDirty,
  isLanded,
  isOnBase,
  issueComments,
  latestSubject,
  openBlockers,
  openIssues,
  push,
  pushToBase,
  reapplyRevert,
  removeWorktree,
  reopenIssue,
  repositorySlug,
  rerunFailedBase,
  resetToBase,
  revertOnBase,
  revision,
  runAgent,
  runCheck,
  runSetup,
  saveEdits,
  setAside,
  setLabel,
  squashOnto,
  startMerge,
  threadComments,
  viewIssue,
  waitForBaseChecks,
};

export type Ports = typeof PORTS;
