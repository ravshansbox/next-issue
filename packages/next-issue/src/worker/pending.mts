import { errorMatches, message } from '../shared/errors.mts';
import type { Issue } from '../shared/github.mts';
import type { Context } from '../shared/job.mts';
import { listedIssues, waitingIssues } from '../shared/skip.mts';
import { type IssueState, readState, savedIssues, writeState } from '../shared/state.mts';
import { blocksLanding, heldOnBase } from '../shared/unsettled.mts';

const ISSUE_GONE = /Could not resolve to an issue or pull request|HTTP 404/;

export async function pendingIssues(context: Context): Promise<Issue[]> {
  const { repo, config, ports } = context;
  const { inProgress, inReview } = config.labels;
  const issues = await listedIssues(ports, repo, config, [inProgress, inReview]);
  const listed = new Set(issues.map((issue) => issue.number));
  for (const issue of await waitingIssues(ports, repo, config)) {
    if (!listed.has(issue.number)) {
      listed.add(issue.number);
      issues.push(issue);
    }
  }
  let openCount = issues.length;
  const states = await savedStates(context);
  for (const [number, state] of states) {
    if (listed.has(number)) {
      continue;
    }
    const { open, issue } = await savedIssue(context, number, state);
    if (open) {
      openCount += 1;
    }
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
  context.recorder.event('issues', { open: openCount });
  const blocking = blockingIssues(context, states);
  return issues.sort(
    (a, b) =>
      Number(blocking.has(b.number)) - Number(blocking.has(a.number)) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

type SavedState = IssueState | 'broken' | undefined;

async function savedStates(context: Context): Promise<Map<number, SavedState>> {
  const { repo } = context;
  const states = new Map<number, SavedState>();
  for (const number of await savedIssues(repo)) {
    states.set(number, await readState(repo, number).catch(() => 'broken' as const));
  }
  return states;
}

function blockingIssues(context: Context, states: Map<number, SavedState>): Set<number> {
  const blocking = new Set<number>();
  for (const [number, state] of states) {
    if (state !== undefined && state !== 'broken' && blocksLanding(state, context.base)) {
      blocking.add(number);
    }
  }
  return blocking;
}

async function savedIssue(
  context: Context,
  number: number,
  saved: SavedState,
): Promise<{ open: boolean; issue?: Issue }> {
  const { repo, ports } = context;
  if (saved === undefined) {
    return { open: false };
  }
  try {
    const { open, ...issue } = await ports.viewIssue(repo, number);
    if (saved === 'broken' || open) {
      return { open, issue };
    }
    return { open, issue: { ...issue, closed: true } };
  } catch (error) {
    const log = context.recorder.scope({ issue: number });
    log.event('issue.unreadable', { error: message(error) });
    if (saved !== 'broken' && errorMatches(error, ISSUE_GONE)) {
      await releaseGone(context, saved);
    }
    return { open: false };
  }
}

async function releaseGone(context: Context, saved: IssueState): Promise<void> {
  if (!blocksLanding(saved, context.base)) {
    return;
  }
  delete saved.halted;
  await writeState(context.repo, saved);
  context.recorder
    .scope({ issue: saved.issue })
    .event('land.released', { held: heldOnBase(saved, context.base), reason: 'issue not found' });
}
