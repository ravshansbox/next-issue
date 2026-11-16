import { startWorker } from '../src/serve.mts';
import { workerPaths } from '../src/worker-paths.mts';

const root = process.cwd();
const { logPath: _logPath, ...paths } = workerPaths(root);
const started = await startWorker({
  root,
  ...paths,
  version: process.argv[2] ?? '2.1.0',
  questions: async () => [],
  runRepo: (_root, _args, controls) =>
    new Promise((resolve) => {
      const timer = setInterval(() => {
        if (controls.interrupts.afterIssue()) {
          clearInterval(timer);
          resolve(0);
        }
      }, 20);
    }),
});
if (started !== undefined) {
  await started.closed;
}
