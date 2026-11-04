import { minutesToMs } from './durations.mts';
import { succeeded } from './exec.mts';
import { escalateAndFinish } from './handover.mts';
import { ROUND_CONTINUE, type Round, type Run } from './job.mts';
import type { SetupResult } from './ports.mts';
import { keepTail } from './text.mts';

export async function setUp(job: Run): Promise<Round> {
  const { context, log, worktree } = job;
  const { config, ports } = context;
  const setupCommand = config.setupCommand ?? (await ports.detectSetupCommand(worktree));
  if (setupCommand === undefined) {
    return ROUND_CONTINUE;
  }
  const setup = await log.step(
    'setup',
    { cmd: setupCommand, found: config.setupCommand === undefined },
    () => ports.runSetup(setupCommand, worktree, minutesToMs(config.setupTimeoutMinutes)),
  );
  if (succeeded(setup)) {
    return ROUND_CONTINUE;
  }
  return setupFailed(job, setup);
}

async function setupFailed(job: Run, setup: SetupResult): Promise<Round> {
  const late = setup.timedOut === true;
  job.log.event(
    'setup.fail',
    { code: setup.code, timedOut: late, stderr: keepTail(setup.stderr.trim(), 2000) },
    'quiet',
  );
  return escalateAndFinish(
    job,
    late
      ? `The setup command did not finish in ${job.context.config.setupTimeoutMinutes} minutes.`
      : 'The setup command failed in the worktree.',
    late ? 'setup timeout' : 'setup failed',
  );
}
