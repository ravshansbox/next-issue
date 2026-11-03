import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repo } from './git.mts';
import { hasCode } from './observe.mts';

export const STATE_DIR = '.next-issue';

export type Phase = 'claimed' | 'implemented' | 'review';

export type IssueState = {
  issue: number;
  phase: Phase;
  branch: string;
  pr?: number;
  title?: string;
  ciFixes: number;
  commitFixes?: number;
  baseFix?: BaseFix;
  reviewRounds: number;
  reviewLog: ReviewRound[];
  handedOver?: boolean;
};

export type BaseFix = {
  sha: string;
  head: string;
};

export type ReviewRound = {
  round: number;
  findings: string;
  dispute?: string;
};

export function stateDir(root: string): string {
  return join(root, STATE_DIR);
}

function file(repo: Repo, issue: number): string {
  return join(stateDir(repo.root), `${issue}.json`);
}

export async function readState(repo: Repo, issue: number): Promise<IssueState | undefined> {
  const path = file(repo, issue);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the state file ${path} is not valid JSON`);
  }
  if (!isState(parsed)) {
    throw new Error(`the state file ${path} does not hold a valid state`);
  }
  return parsed;
}

const PHASES: readonly unknown[] = ['claimed', 'implemented', 'review'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOptional(value: unknown, type: 'boolean' | 'number' | 'string'): boolean {
  return value === undefined || typeof value === type;
}

function isBaseFix(value: unknown): value is BaseFix {
  return isRecord(value) && typeof value.sha === 'string' && typeof value.head === 'string';
}

function isReviewRound(value: unknown): value is ReviewRound {
  return (
    isRecord(value) &&
    typeof value.round === 'number' &&
    typeof value.findings === 'string' &&
    isOptional(value.dispute, 'string')
  );
}

function isState(value: unknown): value is IssueState {
  return (
    isRecord(value) &&
    typeof value.issue === 'number' &&
    PHASES.includes(value.phase) &&
    typeof value.branch === 'string' &&
    isOptional(value.pr, 'number') &&
    isOptional(value.title, 'string') &&
    typeof value.ciFixes === 'number' &&
    isOptional(value.commitFixes, 'number') &&
    (value.baseFix === undefined || isBaseFix(value.baseFix)) &&
    typeof value.reviewRounds === 'number' &&
    Array.isArray(value.reviewLog) &&
    value.reviewLog.every(isReviewRound) &&
    isOptional(value.handedOver, 'boolean')
  );
}

export async function savedIssues(repo: Repo): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(stateDir(repo.root));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(\d+)\.json$/.exec(name);
    return match === null ? [] : [Number(match[1])];
  });
}

export function resetState(state: IssueState): IssueState {
  const { handedOver: _handedOver, ...rest } = state;
  return { ...rest, ciFixes: 0, commitFixes: 0, reviewRounds: 0, reviewLog: [] };
}

export async function writeState(repo: Repo, state: IssueState): Promise<void> {
  await mkdir(stateDir(repo.root), { recursive: true });
  await writeFile(file(repo, state.issue), `${JSON.stringify(state, null, 2)}\n`);
}

export async function dropState(repo: Repo, issue: number): Promise<void> {
  await rm(file(repo, issue), { force: true });
}
