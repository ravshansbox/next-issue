import { randomUUID } from 'node:crypto';
import { givenStartFlags } from '../shared/args.mts';
import { isNewer, type Progress } from '../shared/protocol.mts';
import { packageVersion } from '../shared/version.mts';
import {
  ANSWER_TIMEOUT_MS,
  CLOSED,
  type Connection,
  going,
  reachWorker,
  startedRun,
} from '../shared/worker-client.mts';
import { statusText, switched } from './switch-run.mts';

const REFUSED_GOING = [
  'a run is going in this repository already',
  'the worker is restarting, try again soon',
];

const SILENT = 'the next-issue worker did not answer';

const STARTED =
  'the run started in the worker; follow it with `npx -y next-issue@latest logs` and stop it with `npx -y next-issue@latest stop`\n';

export async function startInWorker(root: string, argv: string[]): Promise<string> {
  const version = await packageVersion();
  const given = givenStartFlags(argv);
  const connection = await reachWorker(root, version);
  try {
    const progress = connection.runs[root];
    if (going(progress)) {
      const join = await joined(connection, root, argv, progress!);
      if (join.joined) {
        return `a run is going already\n${statusText(connection.version, join.progress)}`;
      }
      if (!isNewer(version, connection.version) || !REFUSED_GOING.includes(join.refusal)) {
        throw new Error(join.refusal);
      }
      let latest = join.progress;
      if (given.watch !== undefined) {
        latest = await switched(connection, root, 'watch', given.watch);
      }
      if (given.hunt !== undefined) {
        latest = await switched(connection, root, 'hunt', given.hunt);
      }
      return `a run is going already\n${statusText(connection.version, latest)}`;
    }
    const id = randomUUID();
    const accepted = startedRun(connection, root, id);
    connection.send({ type: 'start', root, args: argv, id });
    await accepted;
    return STARTED;
  } finally {
    connection.close();
  }
}

type Join =
  | { joined: true; progress: Progress }
  | { joined: false; progress: Progress; refusal: string };

function joined(
  connection: Connection,
  root: string,
  argv: string[],
  known: Progress,
): Promise<Join> {
  const id = randomUUID();
  let latest = known;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SILENT)), ANSWER_TIMEOUT_MS);
    const settle = (join: Join): void => {
      clearTimeout(timer);
      resolve(join);
    };
    connection.listen((message) => {
      if (message.type === 'runs' && message.runs[root] !== undefined) {
        latest = message.runs[root];
        if (message.id === id) {
          settle({ joined: true, progress: latest });
        }
      } else if (
        message.type === 'error' &&
        message.root === root &&
        (message.id === id || message.id === undefined)
      ) {
        settle({ joined: false, progress: latest, refusal: message.message });
      }
    });
    void connection.closed.then(() => {
      clearTimeout(timer);
      reject(new Error(CLOSED));
    });
    connection.send({ type: 'start', root, args: argv, id });
  });
}
