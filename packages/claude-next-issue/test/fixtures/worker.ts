import { join } from 'node:path';
import { startWorker } from '../../../next-issue/src/worker/serve.mts';

const [root = '', version = '2.0.0', fail] = process.argv.slice(2);
if (fail === 'fail') {
  process.stderr.write('next-issue: the worker failed\n');
  process.exit(3);
}
const worker = await startWorker({
  root,
  socketPath: join(root, '.next-issue', 'worker.sock'),
  lockPath: join(root, '.next-issue', 'worker.lock'),
  version,
  runRepo: () => new Promise<number>(() => {}),
  questions: async () => [],
  idleMs: 2_000,
});
await worker?.closed;
