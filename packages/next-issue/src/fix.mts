import { CODING } from './agents.mts';
import { HookError } from './git.mts';
import type { Run } from './job.mts';
import { message } from './observe.mts';
import {
  type FixKind,
  fixPrompt,
  hookPrompt,
  parseCommitSubject,
  parseUnrelated,
} from './prompts.mts';
import { writeState } from './state.mts';

type Fix = { committed: true } | { committed: false; unrelated?: string; stray?: boolean };

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
  const { ports } = context;
  const before = from ?? (await ports.revision(worktree));
  const result = await log.step('fix', { reason }, () =>
    ports.runAgent(log, {
      name: 'fixer',
      cwd: worktree,
      prompt: fixPrompt(issue, reason, detail, earlier, kind),
      profile: CODING,
      model: context.config.models.fixer,
      timeoutMs: context.config.agentTimeoutMinutes * 60_000,
    }),
  );
  const unrelated = parseUnrelated(result.text);
  if (unrelated !== undefined) {
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
  const subject = parseCommitSubject(
    result.text,
    `fix: address feedback on issue #${issue.number}`,
  );
  if (!(await commitWork(job, before, subject, 'fixer'))) {
    log.event('commit.empty', { reason }, 'quiet');
    return { committed: false };
  }
  await ports.push(worktree, context.config.remote, branch, force);
  return { committed: true };
}

export async function commitWork(
  job: Run,
  before: string,
  subject: string,
  role: 'implementer' | 'fixer',
): Promise<boolean> {
  const { context, issue, log, state, worktree, comments } = job;
  const { repo, config, ports } = context;
  for (;;) {
    try {
      if (await ports.commitAll(worktree, `${subject}\n\nRefs #${issue.number}`)) {
        log.event('commit', { subject });
      }
      if ((await ports.revision(worktree)) === before) {
        return false;
      }
      state.title = subject;
      return true;
    } catch (error) {
      const used = state.commitFixes ?? 0;
      if (!(error instanceof HookError) || used >= config.maxCommitFixes) {
        throw error;
      }
      state.commitFixes = used + 1;
      await writeState(repo, state);
      const output = message(error).slice(-config.logMaxChars);
      log.event('commit.fail', { role, output }, 'quiet');
      const fix = await log.step('commit-fix', { role }, () =>
        ports.runAgent(log, {
          name: role,
          cwd: worktree,
          prompt: hookPrompt(issue, comments, role, output),
          profile: CODING,
          model: config.models[role],
          timeoutMs: config.agentTimeoutMinutes * 60_000,
        }),
      );
      subject = parseCommitSubject(fix.text, subject);
    }
  }
}
