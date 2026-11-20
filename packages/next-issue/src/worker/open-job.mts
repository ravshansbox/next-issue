import type { Issue } from '../shared/github.mts';
import { handOverReply, writerComments } from '../shared/hand-over-comments.mts';
import { type Context, type Run, setStatus } from '../shared/job.mts';
import { oneAtATime } from '../shared/lock.mts';
import type { Recorder } from '../shared/observe.mts';
import { type IssueState, type PendingHandOver, writeState } from '../shared/state.mts';

export async function openJob(
  context: Context,
  issue: Issue,
  log: Recorder,
  state: IssueState,
  start: boolean,
  handedOver: boolean,
  pending?: PendingHandOver,
): Promise<Run> {
  const started = Date.now();
  const { repo, config } = context;
  const branch = state.branch;

  await log.step('claim', { label: config.labels.inProgress }, async () => {
    await writeState(repo, handedOver ? { ...state, ...handOverMark(pending) } : state);
    await setStatus(context, issue.number, config.labels.inProgress);
    if (handedOver) {
      await writeState(repo, state);
    }
  });

  const comments = await log.step('comments', {}, () => writerComments(context, log, issue.number));
  const reply = handedOver
    ? await log.step('reply', {}, () => handOverReply(context, issue.number, pending))
    : [];
  const worktree = await openWorktree(context, issue, log, branch, start);
  if (state.fresh === true) {
    delete state.fresh;
    await writeState(repo, state);
  }
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
    mainBroken: false,
    repairing: false,
    asides: [],
  };
}

function handOverMark(pending: PendingHandOver | undefined): Partial<IssueState> {
  return pending === undefined ? { handedOver: true } : { pendingHandOver: pending };
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
    log.event('base.behind', { base: context.base });
  }
  if (!added.branchUpdated) {
    log.event('branch.behind', { branch });
  }
  return added.path;
}
