import { randomUUID } from 'node:crypto';
import { going, isNewer, type Progress, type RunningIssue } from '../shared/protocol.mts';
import { packageVersion } from '../shared/version.mts';
import {
  ANSWER_TIMEOUT_MS,
  CLOSED,
  type Connection,
  findWorker,
} from '../shared/worker-client.mts';

export type SwitchName = 'watch' | 'hunt';

const FIELDS = { watch: 'watching', hunt: 'hunting' } as const;

const NO_RUN = 'no run is going in this repository\n';

export const SILENT = 'the next-issue worker did not answer';

function onOffText(on: boolean | undefined): string {
  return on === true ? 'on' : 'off';
}

export function switchInWorker(root: string, name: SwitchName, on: boolean): Promise<string> {
  return inWorker(root, async (connection) => {
    if (isNewer(await packageVersion(), connection.version)) {
      throw new Error(
        `the worker of the going run is older than next-issue, so it cannot switch ${FIELDS[name]}. Stop the run, then start it again`,
      );
    }
    const progress = await switched(connection, root, name, on);
    return `watching ${onOffText(progress.watching)}, hunting ${onOffText(progress.hunting)}\n`;
  });
}

async function inWorker(
  root: string,
  act: (connection: Connection, progress: Progress) => Promise<string>,
): Promise<string> {
  const connection = await findWorker(root);
  if (connection === undefined) {
    return NO_RUN;
  }
  try {
    const progress = connection.runs[root];
    if (!going(progress)) {
      return NO_RUN;
    }
    return await act(connection, progress!);
  } finally {
    connection.close();
  }
}

export function switched(
  connection: Connection,
  root: string,
  name: SwitchName,
  on: boolean,
  olderWorker = false,
): Promise<Progress> {
  const id = randomUUID();
  let sent = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SILENT)), ANSWER_TIMEOUT_MS);
    connection.listen((message) => {
      if (!sent) {
        return;
      }
      const progress = message.type === 'runs' ? message.runs[root] : undefined;
      const answered = olderWorker
        ? progress?.[FIELDS[name]] === on
        : message.type === 'runs' && message.id === id;
      if (progress !== undefined && answered) {
        clearTimeout(timer);
        resolve(progress);
      } else if (message.type === 'error' && message.id === id) {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    void connection.closed.then(() => {
      clearTimeout(timer);
      reject(new Error(CLOSED));
    });
    connection.send({ type: name, root, on, id });
    sent = true;
  });
}

export function stopInWorker(root: string): Promise<string> {
  return inWorker(root, async (connection, progress) => {
    if (progress.status === 'stopping' && progress.upgrade === undefined) {
      return 'the run is stopping already\n';
    }
    const reply = await stopReply(connection, root);
    return `${stopText(progress, reply)}\n`;
  });
}

type StopReply = { waiting: boolean; hunting: boolean };

function stopReply(connection: Connection, root: string): Promise<StopReply | undefined> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS);
    connection.listen((message) => {
      if (message.type === 'stopping' && message.id === id) {
        clearTimeout(timer);
        resolve(message);
      } else if (message.type === 'error' && message.id === id) {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    void connection.closed.then(() => {
      clearTimeout(timer);
      resolve(undefined);
    });
    connection.send({ type: 'stop', root, after: 'issue', id });
  });
}

function stopText(progress: Progress, reply: StopReply | undefined): string {
  const upgrading = progress.upgrade !== undefined;
  const ending = upgrading ? ' and not start again' : '';
  if (reply === undefined) {
    return `the run will stop after its current issues${ending}`;
  }
  const waits = progress.issues.map(({ issue }) => `#${issue}`);
  if (reply.hunting) {
    waits.push('its current hunt');
  }
  if (waits.length > 0) {
    return `the run will stop after ${listText(waits)}${ending}`;
  }
  const state = reply.waiting ? 'the run stopped' : 'the run is stopping';
  return upgrading ? `${state} and will not start again` : state;
}

function listText(items: string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function statusInWorker(root: string): Promise<string> {
  return inWorker(root, async (connection, progress) =>
    statusText(await packageVersion(), connection.version, progress),
  );
}

export function statusText(cliVersion: string, workerVersion: string, progress: Progress): string {
  const hunting = onOffText(progress.hunting);
  const lines = [
    `cli: ${cliVersion}`,
    `worker: ${workerVersion}`,
    `state: ${progress.status}`,
    `watching: ${onOffText(progress.watching)}`,
    `hunting: ${progress.hunt === true ? `${hunting} (hunting now)` : hunting}`,
  ];
  if (progress.upgrade !== undefined) {
    lines.push(`upgrade: stopping for ${progress.upgrade.to}`);
  }
  if (progress.issues.length === 0) {
    lines.push(`issues: ${idleText(progress)}`);
  } else {
    lines.push('issues:', ...progress.issues.map((issue) => `  ${issueLine(issue)}`));
  }
  return `${lines.join('\n')}\n`;
}

function idleText(progress: Progress): string {
  if (progress.status !== 'running') {
    return 'none';
  }
  const minutes =
    progress.nextLook === undefined
      ? 0
      : Math.ceil((Date.parse(progress.nextLook) - Date.now()) / 60_000);
  if (minutes > 0) {
    return `none, next look in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return progress.looking === true || progress.nextLook !== undefined
    ? 'none, looking for one'
    : 'none';
}

function issueLine({ issue, step, round }: RunningIssue): string {
  const roundText = round === undefined ? '' : ` (round ${round})`;
  return `#${issue} ${step?.replaceAll('-', ' ') ?? 'starting'}${roundText}`;
}
