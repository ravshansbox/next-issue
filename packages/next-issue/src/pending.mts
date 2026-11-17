import { errorMatches, message } from './errors.mts';
import type { Issue } from './github.mts';
import type { Context } from './job.mts';
import { listedIssues, waitingIssues } from './skip.mts';
import { type IssueState, readState, savedIssues, writeState } from './state.mts';
import { blocksLanding, heldOnBase } from './unsettled.mts';

/**
 * What `gh issue view` says for an issue that was deleted or moved to another repository. Its GraphQL
 * `repository.issue` lookup does not follow a transfer (only REST does), so a moved issue fails like a deleted one.
 */
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
  const saved = await savedIssues(repo);
  for (const number of saved) {
    if (listed.has(number)) {
      continue;
    }
    const { open, issue } = await savedIssue(context, number);
    if (open) {
      openCount += 1;
    }
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
  context.recorder.event('issues', { open: openCount });
  const blocking = await blockingIssues(context, saved);
  // An issue that blocks every landing goes first, so its resume can lift the block before an older issue reaches the landing.
  return issues.sort(
    (a, b) =>
      Number(blocking.has(b.number)) - Number(blocking.has(a.number)) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

async function blockingIssues(context: Context, saved: number[]): Promise<Set<number>> {
  const { repo, base } = context;
  const blocking = new Set<number>();
  for (const number of saved) {
    const state = await readState(repo, number).catch(() => undefined);
    if (state !== undefined && blocksLanding(state, base)) {
      blocking.add(number);
    }
  }
  return blocking;
}

async function savedIssue(
  context: Context,
  number: number,
): Promise<{ open: boolean; issue?: Issue }> {
  const { repo, ports } = context;
  const saved = await readState(repo, number).catch(() => 'broken' as const);
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

/**
 * A halted issue that was deleted or moved never resumes or gets the skip label, so its halt would block every
 * landing for good: drop it like a given-up issue. The state keeps what is on the base. A passing read failure
 * (a network error) keeps the halt.
 */
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
