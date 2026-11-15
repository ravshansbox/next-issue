import { message } from './errors.mts';
import type { Issue } from './github.mts';
import type { Context } from './job.mts';
import { readState, savedIssues } from './state.mts';
import { blocksLanding } from './unsettled.mts';

export async function pendingIssues(context: Context): Promise<Issue[]> {
  const { repo, config, ports } = context;
  const { ready, inProgress, inReview } = config.labels;
  const labels = ready.length === 0 ? [] : [ready, inProgress, inReview];
  const issues = await ports.openIssues(repo, config.issueLimit, labels);
  const listed = new Set(issues.map((issue) => issue.number));
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
  context.recorder.event('issues', { open: openCount }, 'quiet');
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
    context.recorder
      .scope({ issue: number })
      .event('issue.unreadable', { error: message(error) }, 'quiet');
    return { open: false };
  }
}
