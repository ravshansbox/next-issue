import { randomUUID } from 'node:crypto';
import { isNewer, type Progress } from '../shared/protocol.mts';
import { packageVersion } from '../shared/version.mts';
import { CLOSED, type Connection, findWorker, going } from '../shared/worker-client.mts';

export type SwitchName = 'watch' | 'hunt';

const FIELDS = { watch: 'watching', hunt: 'hunting' } as const;

const NO_RUN = 'next-issue: no run is going in this repository\n';

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
    return `next-issue: watching ${onOffText(progress.watching)}, hunting ${onOffText(progress.hunting)}\n`;
  });
}

export function refreshInWorker(root: string): Promise<string> {
  return inWorker(root, async (connection, progress) => {
    if (isNewer(await packageVersion(), connection.version)) {
      throw new Error(
        'the worker of the going run is older than next-issue, so it cannot refresh. Stop the run, then start it again',
      );
    }
    if (progress.status === 'stopping' && progress.upgrade !== undefined) {
      return 'next-issue: the run is stopping for an upgrade, so nothing was asked; it starts again on the newer worker and picks up new issues then\n';
    }
    if (progress.status === 'stopping') {
      return 'next-issue: the run is stopping, so nothing was asked\n';
    }
    if (progress.watching === false) {
      return 'next-issue: the run does not watch for new issues, so nothing was asked\n';
    }
    connection.send({ type: 'refresh', root });
    await connection.end();
    return 'next-issue: asked the run to check for new issues now\n';
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

function switched(
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
      return 'next-issue: the run is stopping already\n';
    }
    connection.send({ type: 'stop', root, after: 'issue' });
    await connection.end();
    if (progress.upgrade !== undefined) {
      return 'next-issue: the run will stop after its current issues and not start again\n';
    }
    return 'next-issue: the run will stop after its current issues\n';
  });
}
