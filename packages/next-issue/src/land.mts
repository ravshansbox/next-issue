import { runStopped } from './children.mts';
import { rebase } from './conflict.mts';
import { checkGate, escalateError } from './gate.mts';
import { PUSH_TRIES } from './git-land.mts';
import { localChecks } from './local-checks.mts';
import { escalateAndFinish, finishDone, stop } from './handover.mts';
import type { Finished, Run } from './job.mts';
import { oneAtATime } from './lock.mts';
import { revertFailedFix } from './revert.mts';
import { readState, savedIssues, writeState } from './state.mts';
import { beforeBaseSettled, blocksLanding, HALT_NOTE, releaseSettled } from './unsettled.mts';

export function landApproved(job: Run): Promise<Finished> {
  return landing(job, () => landLoop(job));
}

export function resumeLanding(job: Run, sha: string): Promise<Finished> {
  return inLandingLock(job, async () => {
    const { state, context } = job;
    if (await beforeBaseSettled(state, context.base, () => holdsUnlandedFix(job, sha))) {
      return unblocked(job, () => {
        job.mainBroken = true;
        job.repairing = true;
        return landLoop(job);
      });
    }
    // Checking a commit that is already on the base lands nothing, so other halted issues do not hold it back.
    const gate = await checkGate(job, sha);
    if (gate.done) {
      return gate;
    }
    return gate.fixed ? unblocked(job, () => landLoop(job)) : finishDone(job);
  });
}

async function holdsUnlandedFix(job: Run, sha: string): Promise<boolean> {
  const { context, worktree } = job;
  const { ports, config, base } = context;
  if ((await ports.revision(worktree)) === sha) {
    return false;
  }
  return !(await ports.isLanded(worktree, base, config.remote));
}

function landing(job: Run, work: () => Promise<Finished>): Promise<Finished> {
  return inLandingLock(job, () => unblocked(job, work));
}

function inLandingLock(job: Run, work: () => Promise<Finished>): Promise<Finished> {
  return oneAtATime(`${job.context.repo.root}#land`, async () => {
    if (job.context.halted) {
      return holdBack(job, 'run halted');
    }
    return work();
  });
}

/** Runs a step that lands a change, unless an earlier run halted with a commit on the base whose checks nobody read. */
async function unblocked(job: Run, work: () => Promise<Finished>): Promise<Finished> {
  const { log } = job;
  const unchecked = await uncheckedIssues(job);
  if (unchecked.length === 0) {
    return work();
  }
  // Landing now would build on a commit whose checks nobody read. The run claims no more issues, but it does not
  // set `context.halted`: a blocking issue already running must still resume and check its commit on the base.
  log.event('land.blocked', { issues: unchecked }, 'quiet');
  const held = await holdBack(job, 'base unchecked');
  return { ...held, report: { ...held.report, halt: true } };
}

async function holdBack(job: Run, reason: string): Promise<Finished> {
  job.state.phase = 'approved';
  await writeState(job.context.repo, job.state);
  return { done: true, report: stop(job, reason) };
}

/** The other saved issues whose halt left a commit on the base with checks nobody awaited. */
async function uncheckedIssues(job: Run): Promise<number[]> {
  const { repo, base } = job.context;
  const unchecked: number[] = [];
  for (const issue of await savedIssues(repo)) {
    if (issue === job.issue.number) {
      continue;
    }
    // An unreadable state file fails its own issue; it does not hold back every landing.
    const state = await readState(repo, issue).catch(() => undefined);
    if (state !== undefined && blocksLanding(state, base)) {
      unchecked.push(issue);
    }
  }
  return unchecked.sort((a, b) => a - b);
}

async function landLoop(job: Run): Promise<Finished> {
  for (;;) {
    const pushed = await pushChange(job).catch(async (error: unknown) => {
      if (!job.repairing || runStopped()) {
        await revertFailedFix(job);
        throw error;
      }
      job.repairing = false;
      return escalateError(
        job,
        error,
        `The landing of the fix for the checks on ${job.context.base} failed`,
        'fix landing error',
      );
    });
    if (typeof pushed !== 'string') {
      return pushed;
    }
    const gate = await checkGate(job, pushed);
    if (gate.done) {
      return gate;
    }
    if (!gate.fixed) {
      return finishDone(job);
    }
  }
}

async function pushChange(job: Run): Promise<Finished | string> {
  const { context, log, state, worktree } = job;
  const { repo, config, ports, base } = context;
  for (let attempt = 1; ;) {
    const rebased = await rebase(job);
    if (rebased !== undefined) {
      return rebased;
    }
    const checked = await localChecks(job);
    if (checked === false) {
      // The fixer committed: merge the base again and run every check on the result.
      continue;
    }
    if (checked !== true) {
      return checked;
    }
    const sha = await ports.revision(worktree);
    // A halt saved before nothing of this issue was left on the base must not block once this push lands.
    releaseSettled(state);
    state.pushing = sha;
    await writeState(repo, state);
    const pushed = await log.step(
      'land',
      { base, sha },
      async () =>
        (await ports.pushToBase(worktree, config.remote, base)) ||
        ports.isOnBase(worktree, base, config.remote, sha).catch((error: unknown) => {
          if (runStopped()) {
            throw error;
          }
          return undefined;
        }),
    );
    if (pushed === undefined) {
      job.mainBroken = true;
      state.halted = true;
      return escalateAndFinish(
        job,
        `The push to ${base} failed and the fetch of ${base} failed too, so the harness cannot tell whether the commit landed. ${HALT_NOTE}`,
        'push unknown',
      );
    }
    state.pushing = undefined;
    if (pushed) {
      state.landed = [...(state.landed ?? []), sha];
      state.halted = true;
    }
    await writeState(repo, state);
    if (pushed) {
      job.repairing = false;
      return sha;
    }
    attempt += 1;
    if (attempt > PUSH_TRIES) {
      return escalateAndFinish(
        job,
        `The push to ${base} failed ${PUSH_TRIES} times.`,
        'push failed',
      );
    }
  }
}
