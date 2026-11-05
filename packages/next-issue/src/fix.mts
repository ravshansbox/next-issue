import { parseCommitSubject, parseUnrelated } from './agent-reply.mts';
import { CODING } from './agents.mts';
import { message } from './errors.mts';
import { HookError } from './git-commit.mts';
import { type BudgetUse, budgetUse } from './handover.mts';
import { type Run, runRole } from './job.mts';
import { type FixKind, fixPrompt, hookPrompt } from './prompts.mts';
import { writeState } from './state.mts';
import { keepTail } from './text.mts';

export type Unfixed = { committed: false; unrelated?: string; stray?: boolean };

export type Fix = { committed: true } | Unfixed;

type CommitRole = 'implementer' | 'fixer';

export async function fixRound(
  job: Run,
  reason: string,
  detail: string,
  earlier: string[],
  kind: FixKind,
  force = false,
  from?: string,
): Promise<Fix> {
  const { context, issue, log, worktree, branch } = job;
  const { ports, config } = context;
  const before = from ?? (await ports.revision(worktree));
  const text = await runFixer(job, reason, detail, earlier, kind);
  const unrelated = parseUnrelated(text);
  if (unrelated !== undefined) {
    return disputedFix(job, before, reason, unrelated);
  }
  const subject = parseCommitSubject(text, `fix: address feedback on issue #${issue.number}`);
  if (!(await commitWork(job, before, subject, 'fixer'))) {
    log.event('commit.empty', { reason }, 'quiet');
    return { committed: false };
  }
  await ports.push(worktree, config.remote, branch, force);
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
    runRole(job, 'fixer', fixPrompt(issue, reason, detail, earlier, kind, job.reply), CODING),
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
  unrelated: string,
): Promise<Fix> {
  const { context, log, worktree, branch } = job;
  const { ports } = context;
  const disputed = await ports.revision(worktree);
  const moved = disputed !== before;
  if (moved) {
    const aside = `${branch}-dispute-${disputed.slice(0, 7)}`;
    await ports.setAside(worktree, before, aside);
    log.event('fix.aside', { branch: aside }, 'quiet');
  }
  const stray = moved || (await ports.isDirty(worktree));
  log.event('fix.unrelated', { reason, note: unrelated, stray }, 'quiet');
  return { committed: false, unrelated, stray };
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
    try {
      if (await commitChanges(worktree, `${subject}\n\nRefs #${issue.number}`)) {
        log.event('commit', { subject });
      }
      if ((await ports.revision(worktree)) === before) {
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
  if (!(error instanceof HookError) || used >= config.maxCommitFixes) {
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
