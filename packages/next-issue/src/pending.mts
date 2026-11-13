import { message } from './errors.mts';
import type { Issue } from './github.mts';
import type { Context } from './job.mts';
import { readState, savedIssues } from './state.mts';

export async function pendingIssues(context: Context): Promise<Issue[]> {
  const { repo, config, ports } = context;
  const { ready, inProgress, inReview } = config.labels;
  const labels = ready.length === 0 ? [] : [ready, inProgress, inReview];
  const issues = await ports.openIssues(repo, config.issueLimit, labels);
  const listed = new Set(issues.map((issue) => issue.number));
  let openCount = issues.length;
  for (const number of await savedIssues(repo)) {
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
  return issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    if (saved === 'broken' || open || (saved.landed ?? []).length > 0) {
      return { open, issue };
    }
    return { open };
  } catch (error) {
    context.recorder
      .scope({ issue: number })
      .event('issue.error', { error: message(error) }, 'quiet');
    return { open: false };
  }
}
