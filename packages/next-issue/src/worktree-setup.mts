import { refuseWhenStopped } from './children.mts';
import { minutesToMs } from './durations.mts';
import { succeeded } from './exec.mts';
import { escalateAndFinish } from './handover.mts';
import { type Finished, ROUND_CONTINUE, type Round, type Run } from './job.mts';
import type { SetupResult } from './ports.mts';
import { keepTail } from './text.mts';
import { heldOnBase, unsettledNote } from './unsettled.mts';

export async function setUp(job: Run): Promise<Round> {
  const setup = await runSetup(job);
  if (setup === undefined || succeeded(setup)) {
    return ROUND_CONTINUE;
  }
  return setupFailed(job, setup, unsettledBase(job));
}

/** Installs the dependencies of the merged base before the local checks; gives the hand-over when the setup fails. */
export async function setUpBeforeChecks(job: Run): Promise<Finished | undefined> {
  const setup = await runSetup(job);
  if (setup === undefined || succeeded(setup)) {
    return undefined;
  }
  return setupFailed(job, setup, '', ' before the local checks');
}

async function runSetup(job: Run): Promise<SetupResult | undefined> {
  const { context, log, worktree } = job;
  const { config, ports } = context;
  const setupCommand = config.setupCommand ?? (await ports.detectSetupCommand(worktree));
  if (setupCommand === undefined) {
    return undefined;
  }
  const setup = await log.step(
    'setup',
    { cmd: setupCommand, found: config.setupCommand === undefined },
    () => ports.runSetup(setupCommand, worktree, minutesToMs(config.setupTimeoutMinutes)),
  );
  refuseWhenStopped();
  return setup;
}

async function setupFailed(
  job: Run,
  setup: SetupResult,
  unsettled: string,
  when = '',
): Promise<Finished> {
  const late = setup.timedOut === true;
  job.log.event('setup.fail', {
    code: setup.code,
    timedOut: late,
    stderr: keepTail(setup.stderr.trim(), 2000),
  });
  if (unsettled !== '') {
    job.mainBroken = true;
    job.state.halted = true;
  }
  const note = late
    ? `The setup command did not finish in ${job.context.config.setupTimeoutMinutes} minutes${when}.`
    : `The setup command failed in the worktree${when}.`;
  return escalateAndFinish(job, `${note}${unsettled}`, late ? 'setup timeout' : 'setup failed');
}

function unsettledBase(job: Run): string {
  const held = heldOnBase(job.state, job.context.base);
  return held === '' ? '' : unsettledNote(held, 'This resume ran the setup');
}
