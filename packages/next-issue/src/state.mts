import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJson } from './errors.mts';
import { readTextIfPresent, unlessMissing, writeJson } from './files.mts';
import type { Repo } from './git.mts';
import { isRecord } from './records.mts';

export const STATE_DIR = '.next-issue';

type Phase = 'claimed' | 'implemented' | 'review';

export type IssueState = {
  issue: number;
  phase: Phase;
  branch: string;
  title?: string;
  implementerReply?: string;
  ciFixes: number;
  commitFixes?: number;
  landed?: string[];
  rerun?: string;
  reviewRounds: number;
  reviewLog: ReviewRound[];
  handedOver?: boolean;
};

export type ReviewRound = {
  round: number;
  findings: string;
  dispute?: string;
};

export function stateDir(root: string): string {
  return join(root, STATE_DIR);
}

export function runsDir(root: string): string {
  return join(stateDir(root), 'runs');
}

function file(repo: Repo, issue: number): string {
  return join(stateDir(repo.root), `${issue}.json`);
}

export async function readState(repo: Repo, issue: number): Promise<IssueState | undefined> {
  const path = file(repo, issue);
  const text = await readTextIfPresent(path);
  if (text === undefined) {
    return undefined;
  }
  return parseState(path, text);
}

function parseState(path: string, text: string): IssueState {
  const parsed = parseJson(text, () => `the state file ${path} is not valid JSON`);
  if (!isState(parsed)) {
    throw new Error(`the state file ${path} does not hold a valid state`);
  }
  return parsed;
}

const PHASES: readonly unknown[] = ['claimed', 'implemented', 'review'];

function isOptional(value: unknown, type: 'boolean' | 'number' | 'string'): boolean {
  return value === undefined || typeof value === type;
}

function isLanded(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((sha) => typeof sha === 'string');
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
    isOptional(value.title, 'string') &&
    isOptional(value.implementerReply, 'string') &&
    typeof value.ciFixes === 'number' &&
    isOptional(value.commitFixes, 'number') &&
    (value.landed === undefined || isLanded(value.landed)) &&
    isOptional(value.rerun, 'string') &&
    typeof value.reviewRounds === 'number' &&
    Array.isArray(value.reviewLog) &&
    value.reviewLog.every(isReviewRound) &&
    isOptional(value.handedOver, 'boolean')
  );
}

export async function savedIssues(repo: Repo): Promise<number[]> {
  const names = (await unlessMissing(() => readdir(stateDir(repo.root)))) ?? [];
  return names.flatMap((name) => {
    const match = /^(\d+)\.json$/.exec(name);
    return match === null ? [] : [Number(match[1])];
  });
}

export function newState(issue: number, branch: string): IssueState {
  return { issue, phase: 'claimed', branch, ciFixes: 0, reviewRounds: 0, reviewLog: [] };
}

export function resetState(state: IssueState): IssueState {
  const { handedOver: _handedOver, ...rest } = state;
  return { ...rest, ciFixes: 0, commitFixes: 0, reviewRounds: 0, reviewLog: [] };
}

export async function writeState(repo: Repo, state: IssueState): Promise<void> {
  await mkdir(stateDir(repo.root), { recursive: true });
  await writeJson(file(repo, state.issue), state);
}

export async function dropState(repo: Repo, issue: number): Promise<void> {
  await rm(file(repo, issue), { force: true });
}
