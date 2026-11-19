import { setTimeout as delay } from 'node:timers/promises';
import { startWorker } from '../src/worker/serve.mts';
import { workerPaths } from '../src/shared/worker-paths.mts';

const root = process.cwd();
const { logPath: _logPath, ...paths } = workerPaths(root);
await delay(Number(process.argv[4] ?? '0'));
const started = await startWorker({
  root,
  ...paths,
  version: process.argv[2] ?? '2.1.0',
  runRepo: (_root, args, controls) =>
    new Promise((resolve) => {
      if (!args.watch) {
        controls.ended?.({
          runId: 'resumed',
          logFile: 'resumed.jsonl',
          roles: {},
          counts: {},
          total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          issues: [],
        });
        resolve(Number(process.argv[3] ?? '0'));
        return;
      }
      const timer = setInterval(() => {
        if (controls.interrupts.afterIssue()) {
          clearInterval(timer);
          controls.output?.(
            `stopped: watching ${args.watch ? 'on' : 'off'}, hunting ${args.hunt ? 'on' : 'off'}\n`,
          );
          resolve(Number(process.argv[3] ?? '0'));
        }
      }, 20);
    }),
});
if (started !== undefined) {
  await started.closed;
}
