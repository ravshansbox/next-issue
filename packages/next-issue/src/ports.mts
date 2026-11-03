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
  failedBaseLogs,
  failedCheckLogs,
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
  setLabel,
  threadComments,
  viewIssue,
  waitForBaseChecks,
  waitForChecks,
} from './github.mts';
import { detectSetupCommand } from './setup.mts';

export type Ports = {
  abortMerge: typeof abortMerge;
  addWorktree: typeof addWorktree;
  canWrite: typeof canWrite;
  commentOnIssue: typeof commentOnIssue;
  commentOnPr: typeof commentOnPr;
  commitAll: typeof commitAll;
  commitMerge: typeof commitMerge;
  createPr: typeof createPr;
  deleteBranch: typeof deleteBranch;
  detectSetupCommand: typeof detectSetupCommand;
  diff: typeof diff;
  discardChanges: typeof discardChanges;
  disputeBranches: typeof disputeBranches;
  failedBaseLogs: typeof failedBaseLogs;
  failedCheckLogs: typeof failedCheckLogs;
  findPr: typeof findPr;
  findWorktree: typeof findWorktree;
  isDirty: typeof isDirty;
  latestSubject: typeof latestSubject;
  issueComments: typeof issueComments;
  markPrReady: typeof markPrReady;
  mergeCommit: typeof mergeCommit;
  mergePr: typeof mergePr;
  openBlockers: typeof openBlockers;
  openIssues: typeof openIssues;
  prConflicts: typeof prConflicts;
  prMerged: typeof prMerged;
  push: typeof push;
  removeWorktree: typeof removeWorktree;
  reopenIssue: typeof reopenIssue;
  resetToBase: typeof resetToBase;
  revision: typeof revision;
  runAgent: typeof runAgent;
  runSetup: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number; stderr: string; timedOut?: boolean }>;
  setAside: typeof setAside;
  setLabel: typeof setLabel;
  startMerge: typeof startMerge;
  threadComments: typeof threadComments;
  viewIssue: typeof viewIssue;
  waitForBaseChecks: typeof waitForBaseChecks;
  waitForChecks: typeof waitForChecks;
};

export const PORTS: Ports = {
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
  runSetup: async (command, cwd, timeoutMs) => run('bash', ['-lc', command], { cwd, timeoutMs }),
  setAside,
  setLabel,
  startMerge,
  threadComments,
  viewIssue,
  waitForBaseChecks,
  waitForChecks,
};
