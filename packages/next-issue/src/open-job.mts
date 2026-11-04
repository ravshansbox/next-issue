import type { Issue } from './github.mts';
import { handOverReply, writerComments } from './hand-over-comments.mts';
import { type Context, type Run, setStatus } from './job.mts';
import { oneAtATime } from './lock.mts';
import type { Recorder } from './observe.mts';
import { type IssueState, writeState } from './state.mts';

export async function openJob(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  start: boolean,
  handedOver: boolean,
): Promise<Run> {
  const started = Date.now();
  const { repo, config } = context;
  const branch = state.branch;

  await log.step('claim', { label: config.labels.inProgress }, async () => {
    await setStatus(context, issue.number, state.pr, config.labels.inProgress);
    await writeState(repo, state);
  });

  const comments = await log.step('comments', {}, () => writerComments(context, log, issue.number));
  const reply = handedOver
    ? await log.step('reply', {}, () => handOverReply(context, issue.number, state.pr))
    : [];
  const worktree = await openWorktree(context, issue, log, branch, start);
  return {
    context,
    issue,
    log,
    state,
    branch,
    worktree,
    comments,
    reply,
    started,
    noChecks: false,
    mainBroken: false,
  };
}

async function openWorktree(
  context: Context,
  issue: Issue,
  log: Recorder,
  branch: string,
  start: boolean,
): Promise<string> {
  const { repo, config, ports } = context;
  const added = await log.step('worktree', { branch }, () =>
    oneAtATime(repo.root, () =>
      ports.addWorktree(repo, issue.number, branch, context.base, config.remote, start),
    ),
  );
  if (!added.baseUpdated) {
    log.event('base.behind', { base: context.base }, 'quiet');
  }
  return added.path;
}
