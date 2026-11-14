import { refuseWhenStopped } from './children.mts';
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
  refuseWhenStopped();
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
  const unsettled = unsettledBase(job);
  if (unsettled !== '') {
    job.mainBroken = true;
  }
  const note = late
    ? `The setup command did not finish in ${job.context.config.setupTimeoutMinutes} minutes.`
    : 'The setup command failed in the worktree.';
  return escalateAndFinish(job, `${note}${unsettled}`, late ? 'setup timeout' : 'setup failed');
}

function unsettledBase(job: Run): string {
  const { landed, pushing, reverting } = job.state;
  const base = `\`${job.context.base}\``;
  const held = [
    (landed ?? []).length > 0 ? `a landed commit is on ${base}` : '',
    pushing === undefined ? '' : `a push may be on ${base}`,
    reverting === undefined ? '' : `a revert may be on ${base}`,
  ].filter((part) => part !== '');
  if (held.length === 0) {
    return '';
  }
  return ` This resume ran the setup before it checked the base: ${held.join(', ')}, and its checks were not awaited. The run halts, and the next run checks the base again.`;
}
