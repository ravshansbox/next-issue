import { going, type Progress, type StopPoint } from './protocol.ts';
import { accepted } from './requests.ts';
import { cannotNote, formatStatus, handledNote, type Note } from './status.ts';
import type { WorkerClient } from './worker.ts';

function report<Details>(text: string, details: Details) {
  return { content: [{ type: 'text' as const, text }], details };
}

export async function statusOf(client: WorkerClient, root: string) {
  await client.attach();
  if (!client.connected) {
    return report('no worker is running', { root });
  }
  const progress = client.runs[root];
  if (progress === undefined) {
    return report(`no run of ${root}`, { root });
  }
  const lines = [
    formatStatus(progress, Date.now()),
    ...(going(progress) && progress.watching !== undefined
      ? [`watching ${progress.watching ? 'on' : 'off'}`]
      : []),
    ...(going(progress) ? [`hunting ${progress.hunting === true ? 'on' : 'off'}`] : []),
    ...progress.handled.map(handledNote),
  ];
  return report(lines.join('\n'), { root });
}

function goingAlready(root: string, progress: Progress): string {
  const asked =
    progress.status === 'stopping'
      ? 'It is stopping, so it was not asked to check for new issues.'
      : 'Asked it to check for new issues now.';
  return `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. ${asked}`;
}

// Best effort: a worker that knows no refresh ignores it or answers with an error. So it goes
// last, after any request whose answer counts.
function sendRefresh(client: WorkerClient, root: string, progress: Progress): void {
  if (progress.status !== 'stopping') {
    client.request({ type: 'refresh', root });
  }
}

export async function refreshRun(client: WorkerClient, root: string) {
  await client.attach();
  const progress = client.runs[root];
  if (!client.connected || !going(progress)) {
    return report(`No run of ${root} is going, so nothing was asked.`, {
      refreshed: false,
      root,
    });
  }
  if (progress.status === 'stopping') {
    return report(
      `The run of ${root} is stopping, so it would ignore the request and nothing was asked.`,
      { refreshed: false, root },
    );
  }
  if (progress.watching === false) {
    return report(
      `The run of ${root} does not watch for new issues, so it would ignore the request and nothing was asked.`,
      { refreshed: false, root },
    );
  }
  client.request({ type: 'refresh', root });
  return report(`Asked the run of ${root} to check for new issues now.`, {
    refreshed: true,
    root,
  });
}

export async function startRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  signal: AbortSignal | undefined,
) {
  if (going(progress)) {
    sendRefresh(client, root, progress);
    return report(goingAlready(root, progress), { started: false, root });
  }
  await accepted(client, root, client.request({ type: 'start', root }), signal);
  return report(`Started a next-issue run of ${root}.`, { started: true, root });
}

export function requestStart(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
): Note | undefined {
  if (going(progress)) {
    sendRefresh(client, root, progress);
    return { text: goingAlready(root, progress), level: 'info' };
  }
  client.request({ type: 'start', root });
  return undefined;
}

export type SwitchName = 'watch' | 'hunt';

const SWITCH_FIELDS = { watch: 'watching', hunt: 'hunting' } as const;

function outdatedRefusal(client: WorkerClient, name: SwitchName): string | undefined {
  return client.outdated
    ? `the worker of the going run is older than this extension, so it cannot switch ${SWITCH_FIELDS[name]}. Stop the run, then start it again`
    : undefined;
}

async function flip(
  client: WorkerClient,
  root: string,
  name: SwitchName,
  on: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const refusal = outdatedRefusal(client, name);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  const field = SWITCH_FIELDS[name];
  await accepted(
    client,
    root,
    client.request({ type: name, root, on }),
    signal,
    (next) => next?.[field] === on,
    `next_issue_${name}`,
  );
}

export async function watchRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  on: boolean,
  signal: AbortSignal | undefined,
) {
  if (!going(progress)) {
    throw new Error(`no run of ${root} is going`);
  }
  await flip(client, root, 'watch', on, signal);
  const text = on
    ? `The run of ${root} keeps watching for new issues after the current pass.`
    : `The run of ${root} ends after the current pass, with hunting off.`;
  return report(text, { watching: on, root });
}

export async function huntRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  on: boolean,
  signal: AbortSignal | undefined,
) {
  if (!going(progress)) {
    throw new Error(`no run of ${root} is going`);
  }
  await flip(client, root, 'hunt', on, signal);
  const text = on
    ? `Hunting is on for the run of ${root}.`
    : `Hunting is off for the run of ${root}. A hunt that is going finishes, and no new hunt starts.`;
  return report(text, { hunting: on, root });
}

export function requestSwitch(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  name: SwitchName,
  on: boolean,
): Note | undefined {
  if (!going(progress)) {
    return { text: `No run of ${root} is going.`, level: 'info' };
  }
  const refusal = outdatedRefusal(client, name);
  if (refusal !== undefined) {
    return cannotNote(name, refusal);
  }
  client.request({ type: name, root, on });
  return undefined;
}

export function requestStop(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  after: StopPoint,
): Note | undefined {
  if (!going(progress)) {
    return { text: `No run of ${root} is going.`, level: 'info' };
  }
  client.request({ type: 'stop', root, after });
  return undefined;
}

const STOP_TEXTS: Record<StopPoint, string> = {
  issue: 'after the running issues',
  round: 'after the current round',
  now: 'at once',
};

export function stopRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  after: StopPoint,
) {
  if (!going(progress)) {
    throw new Error(`no run of ${root} is going`);
  }
  client.request({ type: 'stop', root, after });
  return report(`Asked the run of ${root} to stop ${STOP_TEXTS[after]}.`, { after, root });
}
