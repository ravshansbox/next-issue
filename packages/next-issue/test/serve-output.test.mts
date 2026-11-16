import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { must } from '../src/exec.mts';
import type { WorkerMessage } from '../src/protocol.mts';
import { runRepo } from '../src/run.mts';
import { startWorker } from '../src/serve.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';
import { connect } from './worker-harness.mts';

const issues = [
  { number: 1, title: 'issue 1', body: '', createdAt: '2026-01-01T00:00:00Z', labels: [] },
];

async function repoWorker(t: TestContext, gh: string) {
  t.mock.method(process.stderr, 'write', () => true);
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/output.git'], {
    cwd: root,
  });
  await mkdir(join(root, '.next-issue'), { recursive: true });
  await writeFile(
    join(root, '.next-issue', 'config.json'),
    JSON.stringify({ labels: { ready: 'status:todo' } }),
  );
  await installGh(t, await tempDir(), gh);
  const dir = await tempDir();
  const started = await startWorker({
    root,
    socketPath: join(dir, 'w.sock'),
    lockPath: join(dir, 'w.lock'),
    version: '2.0.0',
    runRepo,
    questions: async () => [],
  });
  assert.ok(started);
  t.after(() => started.close());
  return { root, client: await connect(t, join(dir, 'w.sock')) };
}

const WORKING_GH = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '${JSON.stringify(issues)}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

async function outputUntilEnd(
  client: Awaited<ReturnType<typeof connect>>,
  root: string,
): Promise<{ lines: string; end: WorkerMessage }> {
  let lines = '';
  for (;;) {
    const value = await client.next(
      (message) => message.type === 'output' || message.type === 'end',
    );
    if (value.type === 'output') {
      assert.equal(value.root, root);
      lines += value.text;
    } else {
      return { lines, end: value };
    }
  }
}

test('a client that starts a run gets the milestone and normal lines but not the commands, then the summary and exit code, while the run log keeps every event', async (t) => {
  const { root, client } = await repoWorker(t, WORKING_GH);
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  const { lines, end } = await outputUntilEnd(client, root);
  assert.match(lines, / run\.start /);
  assert.match(lines, / issue\.skip /);
  assert.doesNotMatch(lines, / command /);
  const runs = join(root, '.next-issue', 'runs');
  const [log] = (await readdir(runs)).filter((name) => name.endsWith('.jsonl'));
  assert.match(await readFile(join(runs, log!), 'utf8'), /"kind":"command"/);
  assert.equal(end.type === 'end' && end.root, root);
  assert.equal(end.type === 'end' && end.code, 0);
  assert.equal(end.type === 'end' && end.error, undefined);
  assert.deepEqual(
    end.type === 'end' && end.summary?.issues.map((report) => [report.issue, report.outcome]),
    [[1, 'skipped']],
  );
});

test('a client of a run that fails gets exit code 1 and the error text of next-issue start', async (t) => {
  const { root, client } = await repoWorker(
    t,
    `#!/bin/sh
echo "gh is broken" >&2
exit 1
`,
  );
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  const { end } = await outputUntilEnd(client, root);
  assert.equal(end.type === 'end' && end.code, 1);
  assert.match(end.type === 'end' ? String(end.error) : '', /gh is broken/);
  assert.equal(end.type === 'end' && end.summary, undefined);
});
