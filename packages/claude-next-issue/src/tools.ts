import { going, type Progress, type StopPoint } from './protocol.ts';
import { formatStatus, handledNote } from './status.ts';
import { refusal, type WorkerClient } from './worker.ts';

export async function statusOf(client: WorkerClient): Promise<string> {
  await client.poll();
  if (!client.connected) {
    return 'no worker is running';
  }
  const progress = client.progress;
  if (progress === undefined) {
    return `no run of ${client.root}`;
  }
  return [
    formatStatus(progress, Date.now()),
    ...(going(progress) && progress.watching !== undefined
      ? [`watching ${progress.watching ? 'on' : 'off'}`]
      : []),
    ...(going(progress) ? [`hunting ${progress.hunting === true ? 'on' : 'off'}`] : []),
    ...progress.handled.map(handledNote),
  ].join('\n');
}

function goingAlready(root: string, progress: Progress): string {
  const asked =
    progress.status === 'stopping'
      ? 'It is stopping, so it was not asked to check for new issues.'
      : progress.watching === false
        ? 'It does not watch for new issues, so it was not asked to check for new issues.'
        : 'Asked it to check for new issues now.';
  return `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. ${asked}`;
}

async function sendRefresh(client: WorkerClient, progress: Progress): Promise<void> {
  if (progress.status !== 'stopping' && progress.watching !== false) {
    await client.send({ type: 'refresh', root: client.root }).catch(() => []);
  }
}

export async function refreshRun(client: WorkerClient): Promise<string> {
  const root = client.root;
  await client.poll();
  const progress = client.progress;
  if (!client.connected || !going(progress)) {
    return `No run of ${root} is going, so nothing was asked.`;
  }
  if (progress.status === 'stopping') {
    return `The run of ${root} is stopping, so it would ignore the request and nothing was asked.`;
  }
  if (progress.watching === false) {
    return `The run of ${root} does not watch for new issues, so it would ignore the request and nothing was asked.`;
  }
  await client.send({ type: 'refresh', root });
  return `Asked the run of ${root} to check for new issues now.`;
}

async function accepted(client: WorkerClient, request: Parameters<WorkerClient['send']>[0]) {
  const problem = refusal(await client.send(request));
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

export async function startRun(client: WorkerClient): Promise<string> {
  await client.ensure();
  const progress = client.progress;
  if (going(progress)) {
    await sendRefresh(client, progress);
    return goingAlready(client.root, progress);
  }
  await accepted(client, { type: 'start', root: client.root });
  return `Started a next-issue run of ${client.root}.`;
}

export type SwitchName = 'watch' | 'hunt';

const SWITCH_FIELDS = { watch: 'watching', hunt: 'hunting' } as const;

async function goingRun(client: WorkerClient): Promise<Progress> {
  await client.reach();
  const progress = client.progress;
  if (!going(progress)) {
    throw new Error(`no run of ${client.root} is going`);
  }
  return progress;
}

export async function switchRun(client: WorkerClient, name: SwitchName, on: boolean) {
  const root = client.root;
  await goingRun(client);
  if (client.outdated) {
    throw new Error(
      `the worker of the going run is older than this plugin, so it cannot switch ${SWITCH_FIELDS[name]}. Stop the run, then start it again`,
    );
  }
  await accepted(client, { type: name, root, on });
  if (name === 'watch') {
    return on
      ? `The run of ${root} keeps watching for new issues after the current pass.`
      : `The run of ${root} ends after the current pass, with hunting off.`;
  }
  return on
    ? `Hunting is on for the run of ${root}.`
    : `Hunting is off for the run of ${root}. A hunt that is going finishes, and no new hunt starts.`;
}

const STOP_TEXTS: Record<StopPoint, string> = {
  issue: 'after the running issues',
  round: 'after the current round',
  now: 'at once',
};

export async function stopRun(client: WorkerClient, after: StopPoint): Promise<string> {
  await goingRun(client);
  await accepted(client, { type: 'stop', root: client.root, after });
  return `Asked the run of ${client.root} to stop ${STOP_TEXTS[after]}.`;
}
