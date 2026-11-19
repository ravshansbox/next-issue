import { randomUUID } from 'node:crypto';
import { isNewer } from '../shared/protocol.mts';
import { packageVersion } from '../shared/version.mts';
import { going, reachWorker, startedRun } from '../shared/worker-client.mts';

const RUN_GOING = 'a run is going in this repository already';

const STARTED =
  'next-issue: the run started in the worker; follow it with next-issue logs and stop it with next-issue stop\n';

export async function startInWorker(root: string, argv: string[]): Promise<string> {
  const version = await packageVersion();
  const connection = await reachWorker(root, version);
  try {
    if (going(connection.runs[root])) {
      throw new Error(
        isNewer(version, connection.version)
          ? `${RUN_GOING}; the worker updates to ${version} after the running issues`
          : RUN_GOING,
      );
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
