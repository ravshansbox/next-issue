import { going, type Progress, STOP_POINTS, type StopPoint } from './protocol.ts';
import { accepted } from './requests.ts';
import { formatStatus, handledNote, type Note } from './status.ts';
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
    ...(going(progress) ? [`hunting ${progress.hunting === true ? 'on' : 'off'}`] : []),
    ...progress.handled.map(handledNote),
  ];
  return report(lines.join('\n'), { root });
}

function sendStart(client: WorkerClient, root: string, args: string[]): void {
  client.send(args.length === 0 ? { type: 'start', root } : { type: 'start', root, args });
}

function goingAlready(root: string, progress: Progress): string {
  return `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. Asked it to check for new issues now.`;
}

// Best effort: a worker that knows no refresh ignores it or answers with an error that does
// not name it. So it goes last, after any request whose answer counts, and `refreshing` lets
// the caller know that a later error answers the refresh.
function sendRefresh(client: WorkerClient, root: string, refreshing: () => void): void {
  client.send({ type: 'refresh', root });
  refreshing();
}

export async function startRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  args: string[],
  signal: AbortSignal | undefined,
  refreshing: () => void = () => {},
) {
  if (going(progress)) {
    if (!turnsHuntingOn(progress, args)) {
      sendRefresh(client, root, refreshing);
      return report(goingAlready(root, progress), { started: false, root });
    }
    await switchHunting(client, root, true, signal, 'next_issue_start');
    sendRefresh(client, root, refreshing);
    return report(`${goingAlready(root, progress)} Turned hunting on.`, {
      started: false,
      hunting: true,
      root,
    });
  }
  const accepting = accepted(client, root, signal);
  sendStart(client, root, args);
  await accepting;
  return report(`Started a next-issue run of ${root}.`, { started: true, root });
}

export function requestStart(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  args: string[],
  refreshing: () => void = () => {},
): Note | undefined {
  if (going(progress)) {
    if (!turnsHuntingOn(progress, args)) {
      sendRefresh(client, root, refreshing);
      return { text: goingAlready(root, progress), level: 'info' };
    }
    // The refresh waits for the hunt answer, so that an error still names the hunt.
    accepted(client, root, undefined, (next) => !going(next) || next?.hunting === true).then(
      () => sendRefresh(client, root, refreshing),
      () => {},
    );
    client.send({ type: 'hunt', root, on: true });
    return { text: `${goingAlready(root, progress)} Turning hunting on.`, level: 'info' };
  }
  sendStart(client, root, args);
  return undefined;
}

function turnsHuntingOn(progress: Progress, args: string[]): boolean {
  return args.includes('--hunt') && progress.hunting !== true;
}

async function switchHunting(
  client: WorkerClient,
  root: string,
  on: boolean,
  signal: AbortSignal | undefined,
  tool: string,
): Promise<void> {
  const accepting = accepted(client, root, signal, (next) => next?.hunting === on, tool);
  client.send({ type: 'hunt', root, on });
  await accepting;
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
  await switchHunting(client, root, on, signal, 'next_issue_hunt');
  const text = on
    ? `Hunting is on for the run of ${root}.`
    : `Hunting is off for the run of ${root}. A hunt that is going finishes, and no new hunt starts.`;
  return report(text, { hunting: on, root });
}

export function parseHuntArgs(args: string[]): boolean {
  const [value, ...rest] = args;
  if (value !== 'on' && value !== 'off') {
    throw new Error(
      value === undefined ? 'hunt takes on or off' : `hunt takes on or off, not ${value}`,
    );
  }
  if (rest[0] !== undefined) {
    throw new Error(`hunt does not take ${rest[0]}`);
  }
  return value === 'on';
}

export function requestHunt(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  on: boolean,
): Note | undefined {
  if (!going(progress)) {
    return { text: `No run of ${root} is going.`, level: 'info' };
  }
  client.send({ type: 'hunt', root, on });
  return undefined;
}

export function parseStopArgs(args: string[]): StopPoint {
  const [flag, value, ...rest] = args;
  if (flag === undefined) {
    return 'issue';
  }
  if (flag !== '--after') {
    throw new Error(`stop does not take ${flag}`);
  }
  const point = STOP_POINTS.find((candidate) => candidate === value);
  if (point === undefined) {
    const known = 'issue, round or now';
    throw new Error(
      value === undefined ? `--after takes ${known}` : `--after takes ${known}, not ${value}`,
    );
  }
  if (rest[0] !== undefined) {
    throw new Error(`stop does not take ${rest[0]}`);
  }
  return point;
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
  client.send({ type: 'stop', root, after });
  return undefined;
}
