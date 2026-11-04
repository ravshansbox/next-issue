import { AsyncLocalStorage } from 'node:async_hooks';
import { setCommandObserver, succeeded } from './exec.mts';
import type { Recorder } from './observe.mts';

const commandRecorder = new AsyncLocalStorage<Recorder>();

setCommandObserver((record) => {
  commandRecorder.getStore()?.event(
    succeeded(record) ? 'command' : 'command.fail',
    {
      cmd: `${record.command} ${record.args.join(' ')}`,
      code: record.code,
      ms: record.ms,
      stderr: record.stderr.length > 0 ? record.stderr : undefined,
      timedOut: record.timedOut ? true : undefined,
    },
    succeeded(record) ? 'verbose' : 'quiet',
  );
});

export function recordCommands<T>(recorder: Recorder, work: () => Promise<T>): Promise<T> {
  return commandRecorder.run(recorder, work);
}
