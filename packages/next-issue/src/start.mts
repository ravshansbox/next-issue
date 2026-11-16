import { randomUUID } from 'node:crypto';
import type { Args } from './args.mts';
import { prettyJson } from './files.mts';
import { NOTES, onPresses } from './interrupt.mts';
import type { RunSummary, WorkerMessage } from './protocol.mts';
import { formatSummary } from './summary.mts';
import { packageVersion } from './version.mts';
import { CLOSED, type Connection, going, reachWorker } from './worker-client.mts';

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
  const connection = await reachWorker(root, await packageVersion());
  if (going(connection.runs[root])) {
    connection.close();
    throw new Error(RUN_GOING);
  }
  const out = output();
  const code = await follow(connection, root, args, argv, out);
  connection.close();
  await out.flushed();
  return code;
}

function follow(
  connection: Connection,
  root: string,
  args: Args,
  argv: string[],
  out: Output,
): Promise<number> {
  const id = randomUUID();
  const stopId = randomUUID();
  const summaryText = (summary: RunSummary): string =>
    args.json ? prettyJson(summary) : formatSummary(summary);
  return new Promise((resolve) => {
    const stopListening = onPresses((presses) => {
      if (presses === 1) {
        connection.send({ type: 'stop', root, after: 'issue', id: stopId });
      } else if (presses === 2) {
        out.print(process.stderr, `${NOTES.round}\n`);
        connection.send({ type: 'stop', root, after: 'round' });
      } else {
        connection.send({ type: 'stop', root, after: 'now' });
      }
    });
    let settled = false;
    const settle = (code: number): void => {
      if (!settled) {
        settled = true;
        stopListening();
        resolve(code);
      }
    };
    const fail = (text: string): void => {
      if (!settled) {
        out.print(process.stderr, `next-issue failed: ${text}\n`);
      }
      settle(1);
    };
    connection.listen((message) => {
      if (!('root' in message) || message.root !== root) {
        return;
      }
      if (message.type === 'output') {
        out.print(process.stderr, message.text);
      } else if (message.type === 'pass') {
        out.print(process.stdout, summaryText(message.summary));
      } else if (message.type === 'stopping' && message.id === stopId) {
        out.print(process.stderr, `${firstNote(message)}\n`);
      } else if (message.type === 'error' && message.id === id) {
        fail(message.message);
      } else if (message.type === 'end' && message.error !== undefined) {
        fail(message.error);
      } else if (message.type === 'end') {
        if (!args.watch && message.summary !== undefined) {
          out.print(process.stdout, summaryText(message.summary));
        }
        settle(message.code);
      }
    });
    void connection.closed.then(() => fail(CLOSED));
    connection.send({ type: 'start', root, args: argv, command: true, id });
  });
}
