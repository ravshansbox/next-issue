import { runAgent } from './agents.mts';
import { failedCiLogs, rerunFailedCi, waitForCiChecks } from './ci-checks.mts';
import { run } from './exec.mts';
import { commitAll } from './git-commit.mts';
import { baseMoved, pushToBase, reapplyRevert, revertOnBase, squashOnto } from './git-land.mts';
import { abortMerge, commitMerge, startMerge } from './git-merge.mts';
import {
  changedFiles,
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
  saveSetupOutput,
  setAside,
} from './git.mts';
import {
  canWrite,
  closeIssue,
  commentOnIssue,
  editIssueBody,
  issueComments,
  issueEditors,
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
  const result = await run('bash', ['-c', `exec 2>&1\n${command}`], { cwd, timeoutMs, tailChars });
  return { code: result.code, output: result.stdout, timedOut: result.timedOut };
}

export const PORTS = {
  abortMerge,
  addWorktree,
  baseMoved,
  canWrite,
  changedFiles,
  closeIssue,
  commentOnIssue,
  commitAll,
  commitMerge,
  deleteBranch,
  detectSetupCommand,
  diff,
  discardChanges,
  disputeBranches,
  editIssueBody,
  ensureLabel,
  failedCiLogs,
  fastForwardBase,
  findWorktree,
  huntWorktree,
  isDirty,
  isLanded,
  isOnBase,
  issueComments,
  issueEditors,
  latestSubject,
  openBlockers,
  openIssues,
  push,
  pushToBase,
  reapplyRevert,
  removeWorktree,
  reopenIssue,
  repositorySlug,
  rerunFailedCi,
  resetToBase,
  revertOnBase,
  revision,
  runAgent,
  runCheck,
  runSetup,
  saveEdits,
  saveSetupOutput,
  setAside,
  setLabel,
  squashOnto,
  startMerge,
  threadComments,
  viewIssue,
  waitForCiChecks,
};

export type Ports = typeof PORTS;
