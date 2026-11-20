import { randomUUID } from 'node:crypto';
import { isNewer, type Progress, type RunningIssue } from '../shared/protocol.mts';
import { packageVersion } from '../shared/version.mts';
import {
  ANSWER_TIMEOUT_MS,
  CLOSED,
  type Connection,
  findWorker,
  going,
} from '../shared/worker-client.mts';

export type SwitchName = 'watch' | 'hunt';

const FIELDS = { watch: 'watching', hunt: 'hunting' } as const;

const NO_RUN = 'no run is going in this repository\n';

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
): Promise<Progress> {
  const id = randomUUID();
  let sent = false;
  return new Promise((resolve, reject) => {
    connection.listen((message) => {
      if (!sent) {
        return;
      }
      const progress = message.type === 'runs' ? message.runs[root] : undefined;
      if (progress !== undefined && progress[FIELDS[name]] === on) {
        resolve(progress);
      } else if (message.type === 'error' && message.id === id) {
        reject(new Error(message.message));
      }
    });
    void connection.closed.then(() => reject(new Error(CLOSED)));
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS);
    connection.listen((message) => {
      if (message.type === 'stopping' && message.id === id) {
        clearTimeout(timer);
        resolve(message);
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
  return inWorker(root, async (connection, progress) => statusText(connection.version, progress));
}

export function statusText(version: string, progress: Progress): string {
  const lines = [
    `${progress.status} in worker ${version}`,
    `watching ${onOffText(progress.watching)}, hunting ${onOffText(progress.hunting)}`,
  ];
  if (progress.upgrade !== undefined) {
    lines.push(`stopping for an upgrade to ${progress.upgrade.to}`);
  }
  if (progress.issues.length === 0) {
    lines.push(idleLine(progress));
  }
  lines.push(...progress.issues.map(issueLine));
  if (progress.hunt === true) {
    lines.push('hunting for bugs');
  }
  return `${lines.join('\n')}\n`;
}

function idleLine(progress: Progress): string {
  if (progress.status !== 'running') {
    return 'no issue is running';
  }
  const minutes =
    progress.nextLook === undefined
      ? 0
      : Math.ceil((Date.parse(progress.nextLook) - Date.now()) / 60_000);
  if (minutes > 0) {
    return `looking again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return progress.looking === true || progress.nextLook !== undefined
    ? 'looking for an issue'
    : 'no issue is running';
}

function issueLine({ issue, step, round }: RunningIssue): string {
  const roundText = round === undefined ? '' : ` (round ${round})`;
  return `#${issue} ${step?.replaceAll('-', ' ') ?? 'starting'}${roundText}`;
}
