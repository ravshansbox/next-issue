import { going, type Progress } from './protocol.ts';
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
  const lines = [formatStatus(progress, Date.now()), ...progress.handled.map(handledNote)];
  return report(lines.join('\n'), { root });
}

function sendStart(client: WorkerClient, root: string, args: string[]): void {
  client.send(args.length === 0 ? { type: 'start', root } : { type: 'start', root, args });
}

function goingAlready(root: string, progress: Progress): string {
  return `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. It picks up new issues by itself.`;
}

export async function startRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  args: string[],
  signal: AbortSignal | undefined,
) {
  if (going(progress)) {
    return report(goingAlready(root, progress), { started: false, root });
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
): Note | undefined {
  if (going(progress)) {
    return { text: goingAlready(root, progress), level: 'info' };
  }
  sendStart(client, root, args);
  return undefined;
}

export function requestStop(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
): Note | undefined {
  if (!going(progress)) {
    return { text: `No run of ${root} is going.`, level: 'info' };
  }
  client.send({ type: 'stop', root });
  return undefined;
}
