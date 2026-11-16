import { randomUUID } from 'node:crypto';
import type { Args } from './args.mts';
import { NOTES, onPresses } from './interrupt.mts';
import {
  type ClientMessage,
  isNewer,
  type Progress,
  type Upgrade,
  type WorkerMessage,
} from './protocol.mts';
import { formatSummary } from './summary.mts';
import { packageVersion } from './version.mts';
import { CLOSED, type Connection, going, reachWorker, rejoinRun } from './worker-client.mts';

const RUN_GOING = 'a run is going in this repository already';

type Output = {
  print: (stream: NodeJS.WriteStream, text: string) => void;
  flushed: () => Promise<void>;
};

function output(): Output {
  let queue = Promise.resolve();
  return {
    print: (stream, text) => {
      queue = queue.then(() => new Promise((resolve) => stream.write(text, () => resolve())));
    },
    flushed: () => queue,
  };
}

function firstNote(message: Extract<WorkerMessage, { type: 'stopping' }>): string {
  if (!message.waiting) {
    return NOTES.issue;
  }
  return message.hunting ? NOTES.hunt : NOTES.wait;
}

export async function startInWorker(root: string, args: Args, argv: string[]): Promise<number> {
  const version = await packageVersion();
  const connection = await reachWorker(root, version);
  if (going(connection.runs[root])) {
    connection.close();
    throw new Error(
      isNewer(version, connection.version)
        ? `${RUN_GOING}; the worker updates to ${version} after the running issues`
        : RUN_GOING,
    );
  }
  const out = output();
  const code = await follow(connection, root, args, argv, out);
  await out.flushed();
  return code;
}

function follow(
  first: Connection,
  root: string,
  args: Args,
  argv: string[],
  out: Output,
): Promise<number> {
  const id = randomUUID();
  const stopId = randomUUID();
  let connection = first;
  let latest: Progress | undefined;
  let upgradeEnd: number | undefined;
  let earlierCode = 0;
  const held: ClientMessage[] = [];
  const send = (message: ClientMessage): void => {
    if (upgradeEnd === undefined) {
      connection.send(message);
    } else {
      held.push(message);
    }
  };
  return new Promise((resolve) => {
    const stopListening = onPresses((presses) => {
      if (presses === 1) {
        send({ type: 'stop', root, after: 'issue', id: stopId });
      } else if (presses === 2) {
        out.print(process.stderr, `${NOTES.round}\n`);
        send({ type: 'stop', root, after: 'round' });
      } else {
        send({ type: 'stop', root, after: 'now' });
      }
    });
    let settled = false;
    const settle = (code: number): void => {
      if (!settled) {
        settled = true;
        stopListening();
        connection.close();
        resolve(Math.max(code, earlierCode));
      }
    };
    const fail = (text: string): void => {
      if (!settled) {
        out.print(process.stderr, `next-issue failed: ${text}\n`);
      }
      settle(1);
    };
    const onMessage = (message: WorkerMessage): void => {
      if (message.type === 'runs') {
        latest = message.runs[root];
      }
      if (!('root' in message) || message.root !== root) {
        return;
      }
      if (message.type === 'output') {
        out.print(process.stderr, message.text);
      } else if (message.type === 'pass') {
        out.print(process.stdout, formatSummary(message.summary));
      } else if (message.type === 'stopping' && message.id === stopId) {
        out.print(process.stderr, `${firstNote(message)}\n`);
      } else if (message.type === 'error' && message.id === id) {
        fail(message.message);
      } else if (message.type === 'end' && message.error !== undefined) {
        fail(message.error);
      } else if (message.type === 'end' && latest?.upgrade !== undefined) {
        upgradeEnd = message.code;
      } else if (message.type === 'end') {
        if (!args.watch && message.summary !== undefined) {
          out.print(process.stdout, formatSummary(message.summary));
        }
        settle(message.code);
      }
    };
    const rejoin = async (upgrade: Upgrade): Promise<void> => {
      const found = await rejoinRun(root).catch(() => undefined);
      if (found === undefined) {
        fail(`${CLOSED}, and the run did not go on in the newer worker`);
        return;
      }
      if (settled) {
        found.close();
        return;
      }
      out.print(
        process.stderr,
        `next-issue: the worker was updated from ${upgrade.from} to ${upgrade.to}\n`,
      );
      earlierCode = Math.max(earlierCode, upgradeEnd ?? 0);
      upgradeEnd = undefined;
      latest = found.runs[root];
      follows(found);
      for (const message of held.splice(0)) {
        found.send(message);
      }
    };
    const closed = (): void => {
      if (upgradeEnd === undefined) {
        fail(CLOSED);
      } else if (latest?.error !== undefined) {
        fail(latest.error);
      } else if (latest?.upgrade === undefined) {
        settle(upgradeEnd);
      } else {
        void rejoin(latest.upgrade);
      }
    };
    const follows = (next: Connection): void => {
      connection = next;
      next.listen(onMessage);
      void next.closed.then(closed);
    };
    follows(first);
    first.send({ type: 'start', root, args: argv, id });
  });
}
