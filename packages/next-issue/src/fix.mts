import {
  parseCommitSubject,
  parseResolved,
  parseUnrelated,
  withoutClosingReferences,
} from './agent-reply.mts';
import { CODING } from './agents.mts';
import { type BudgetUse, budgetUse } from './budget.mts';
import { runStopped } from './children.mts';
import { message } from './errors.mts';
import { HookError } from './git-commit.mts';
import { escalateAndFinish } from './handover.mts';
import { fallbackTitle, type Finished, type Run, runRole } from './job.mts';
import { type FixKind, fixPrompt, hookPrompt } from './prompts.mts';
import { writeState } from './state.mts';
import { keepTail } from './text.mts';

type NoChange = { unrelated: string } | { resolved: string };

export type Unfixed = {
  committed: false;
  unrelated?: string;
  resolved?: string;
  stray?: boolean;
  /** The dispute branch that holds the change a check fixer left behind. */
  aside?: string;
};

export type Fix = { committed: true } | Unfixed;

type CommitRole = 'implementer' | 'fixer';

export function escalateCheckFix(
  job: Run,
  unrelated: string | undefined,
  checks: string,
  after = '',
  aside?: string,
): Promise<Finished> {
  if (unrelated === undefined) {
    return escalateAndFinish(
      job,
      `The fixer added no commit for the failed ${checks}.${after}`,
      'no fix commit',
    );
  }
  return escalateAndFinish(
    job,
    `The ${checks} fail for a reason this change did not cause: ${unrelated}${savedIn(aside)}${after}`,
    'unrelated failure',
  );
}

function savedIn(aside: string | undefined): string {
  return aside === undefined
    ? ''
    : ` The fixer left a change behind; it is saved in the branch \`${aside}\`.`;
}

export async function fixRound(
  job: Run,
  reason: string,
  detail: string,
  earlier: string[],
  kind: FixKind,
): Promise<Fix> {
  const { context, issue, log, worktree } = job;
  const { ports } = context;
  const before = await ports.revision(worktree);
  const text = await runFixer(job, reason, detail, earlier, kind);
  if (kind === 'review') {
    job.state.fixerReply = text;
  }
  const unrelated = parseUnrelated(text);
  if (unrelated !== undefined) {
    return disputedFix(job, before, reason, { unrelated }, kind);
  }
  const resolved = kind === 'review' ? parseResolved(text) : undefined;
  if (resolved !== undefined) {
    return disputedFix(job, before, reason, { resolved }, kind);
  }
  const subject = parseCommitSubject(text, `fix: address feedback on issue #${issue.number}`);
  const title = job.state.title;
  if (kind === 'checks') {
    job.state.changeTitle ??= title;
  }
  const committed = await commitWork(job, before, subject, 'fixer');
  if (kind === 'review') {
    job.state.title = title;
  }
  if (!committed) {
    log.event('commit.empty', { reason }, 'quiet');
    return { committed: false };
  }
  return { committed: true };
}

export async function runFixer(
  job: Run,
  reason: string,
  detail: string,
  earlier: string[],
  kind: FixKind,
): Promise<string> {
  const { issue, log } = job;
  const result = await log.step('fix', { reason, cause: kind, ...fixBudget(job, kind) }, () =>
    runRole(
      job,
      'fixer',
      fixPrompt(issue, job.comments, reason, detail, earlier, kind, job.reply),
      CODING,
    ),
  );
  return result.text;
}

function fixBudget(job: Run, kind: FixKind): BudgetUse {
  return budgetUse(job, kind === 'review' ? 'reviewRounds' : 'ciFixes');
}

async function disputedFix(
  job: Run,
  before: string,
  reason: string,
  note: NoChange,
  kind: FixKind,
): Promise<Fix> {
  const { context, issue, log, worktree, branch } = job;
  const { ports } = context;
  // The revert after a failed check reuses this worktree, so edits left there would be lost.
  const saved =
    kind === 'checks' &&
    (await ports.saveEdits(
      worktree,
      `fix: edits left by the check fixer\n\nRefs #${issue.number}`,
    ));
  const disputed = await ports.revision(worktree);
  const moved = disputed !== before;
  if (moved) {
    const aside = `${branch}-dispute-${disputed.slice(0, 7)}`;
    await ports.setAside(worktree, before, aside);
    log.event('fix.aside', { branch: aside, saved }, 'quiet');
    if (kind === 'checks') {
      return disputedNote(job, reason, note, { stray: true, aside });
    }
  }
  return disputedNote(job, reason, note, { stray: moved || (await ports.isDirty(worktree)) });
}

function disputedNote(
  job: Run,
  reason: string,
  note: NoChange,
  left: { stray: boolean; aside?: string },
): Fix {
  const event = 'unrelated' in note ? 'fix.unrelated' : 'fix.resolved';
  job.log.event(event, { reason, note: Object.values(note)[0], ...left }, 'quiet');
  return { committed: false, ...note, ...left };
}

export async function commitWork(
  job: Run,
  before: string,
  subject: string,
  role: CommitRole,
  commit?: (worktree: string, message: string) => Promise<boolean>,
): Promise<boolean> {
  const { context, issue, log, state, worktree } = job;
  const { ports } = context;
  const commitChanges = commit ?? ports.commitAll;
  for (;;) {
    subject = withoutClosingReferences(subject, fallbackTitle(issue));
    try {
      const committed = await commitChanges(worktree, `${subject}\n\nRefs #${issue.number}`);
      if (committed) {
        log.event('commit', { subject });
      }
      if (!committed && (await ports.revision(worktree)) === before) {
        return false;
      }
      state.title = subject;
      return true;
    } catch (error) {
      subject = await hookFix(job, error, subject, role);
    }
  }
}

async function hookFix(
  job: Run,
  error: unknown,
  subject: string,
  role: CommitRole,
): Promise<string> {
  const { context, issue, log, state, comments } = job;
  const { repo, config } = context;
  const used = state.commitFixes ?? 0;
  if (!(error instanceof HookError) || runStopped() || used >= config.maxCommitFixes) {
    throw error;
  }
  state.commitFixes = used + 1;
  await writeState(repo, state);
  const output = keepTail(message(error), config.logMaxChars);
  log.event('commit.fail', { role, output }, 'quiet');
  const fix = await log.step(
    'commit-fix',
    { role, round: state.commitFixes, limit: config.maxCommitFixes },
    () => runRole(job, role, hookPrompt(issue, comments, role, output), CODING),
  );
  return parseCommitSubject(fix.text, subject);
}
