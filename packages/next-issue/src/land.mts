import { runStopped } from './children.mts';
import { rebase } from './conflict.mts';
import { checkGate, escalateError } from './gate.mts';
import { PUSH_TRIES } from './git-land.mts';
import { updateLocalBase } from './local-base.mts';
import { localChecks } from './local-checks.mts';
import { escalateAndFinish, finishDone, stop } from './handover.mts';
import type { Finished, Run } from './job.mts';
import { oneAtATime } from './lock.mts';
import { readState, savedIssues, writeState } from './state.mts';
import { outputBlock } from './text.mts';
import { beforeBaseSettled, blocksLanding, HALT_NOTE, releaseSettled } from './unsettled.mts';

const GIT_ERROR_CHARS = 1000;

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
  job.slot?.free();
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
    const halted = state.halted;
    state.pushing = sha;
    state.halted = true;
    await writeState(repo, state);
    let failure = '';
    const pushed = await log.step('land', { base, sha }, async () => {
      const push = await ports.pushToBase(worktree, config.remote, base);
      if (push.pushed) {
        return true;
      }
      failure = push.error;
      return ports.isOnBase(worktree, base, config.remote, sha).catch((error: unknown) => {
        if (runStopped()) {
          throw error;
        }
        return undefined;
      });
    });
    if (pushed === undefined) {
      job.mainBroken = true;
      return escalateAndFinish(
        job,
        `The push to ${base} failed and the fetch of ${base} failed too, so the harness cannot tell whether the commit landed. ${HALT_NOTE}`,
        'push unknown',
      );
    }
    state.pushing = undefined;
    if (pushed) {
      state.landed = [...(state.landed ?? []), sha];
    } else if (halted !== true) {
      delete state.halted;
    }
    await writeState(repo, state);
    if (pushed) {
      job.repairing = false;
      await updateLocalBase(job);
      return sha;
    }
    if (!(await ports.baseMoved(worktree, base, config.remote))) {
      return escalateAndFinish(
        job,
        `The push to ${base} failed, and ${base} did not move, so the harness did not try again.${gitError('The error of git:', failure)}`,
        'push failed',
      );
    }
    attempt += 1;
    if (attempt > PUSH_TRIES) {
      return escalateAndFinish(
        job,
        `The push to ${base} failed ${PUSH_TRIES} times.${gitError('The last error of git:', failure)}`,
        'push failed',
      );
    }
  }
}

function gitError(label: string, failure: string): string {
  const block = outputBlock(failure, GIT_ERROR_CHARS);
  return block === '' ? '' : ` ${label}${block}`;
}
