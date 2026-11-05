import { going, type Progress } from './protocol.ts';
import { accepted } from './requests.ts';
import { formatStatus, handledNote } from './status.ts';
import type { WorkerClient } from './worker.ts';

function report(text: string, root: string) {
  return { content: [{ type: 'text' as const, text }], details: { root } };
}

function startReport(text: string, root: string, started: boolean) {
  return { ...report(text, root), details: { started, root } };
}

export async function statusOf(client: WorkerClient, root: string) {
  await client.attach();
  if (!client.connected) {
    return report('no worker is running', root);
  }
  const progress = client.runs[root];
  if (progress === undefined) {
    return report(`no run of ${root}`, root);
  }
  const lines = [formatStatus(progress, Date.now()), ...progress.handled.map(handledNote)];
  return report(lines.join('\n'), root);
}

function sendStart(client: WorkerClient, root: string): void {
  client.send({ type: 'start', root, merge: true });
}

export async function startRun(
  client: WorkerClient,
  root: string,
  progress: Progress | undefined,
  signal: AbortSignal | undefined,
) {
  if (going(progress)) {
    return startReport(
      `A run of ${root} is going already, so nothing started: ${formatStatus(progress, Date.now())}. It picks up new issues by itself.`,
      root,
      false,
    );
  }
  const accepting = accepted(client, root, signal);
  sendStart(client, root);
  await accepting;
  return startReport(`Started a next-issue run of ${root}.`, root, true);
}

export function toggle(client: WorkerClient, root: string, progress: Progress | undefined): void {
  if (going(progress)) {
    client.send({ type: 'stop', root });
  } else {
    sendStart(client, root);
  }
}
