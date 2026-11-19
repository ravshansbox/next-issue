import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { must } from '../src/shared/exec.mts';
import type { RunSummary, WorkerMessage } from '../src/shared/protocol.mts';
import { runRepo } from '../src/worker/run.mts';
import { startWorker } from '../src/worker/serve.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';
import { connect, fakeRegistry, fakeRuns, worker } from './worker-harness.mts';

const issues = [
  { number: 1, title: 'issue 1', body: '', createdAt: '2026-01-01T00:00:00Z', labels: [] },
];

async function repoWorker(t: TestContext, gh: string, registry?: string) {
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
    registry: registry ?? (await fakeRegistry(t, { version: '2.0.0' })).url,
    successorLaunch: () => ({ command: join(root, 'missing'), args: ['serve'] }),
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

test('a client of a run whose summary is larger than 64 KiB gets the whole summary in the end message', async (t) => {
  const fake = fakeRuns();
  const { root, socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  await client.next((message) => message.type === 'runs' && message.runs[root] !== undefined);
  const summary: RunSummary = {
    runId: 'run',
    logFile: 'run.jsonl',
    roles: {},
    counts: {},
    total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    issues: Array.from({ length: 2000 }, (_, index) => ({
      issue: index + 1,
      outcome: 'needs-human' as const,
      reason: 'x'.repeat(1000),
      ciFixes: 0,
      reviewRounds: 0,
      ms: 0,
    })),
  };
  assert.ok(JSON.stringify(summary).length > 64 * 1024);
  fake.controls().ended?.(summary);
  fake.finish(0);
  const end = await client.next((message) => message.type === 'end');
  assert.deepEqual(end, { type: 'end', root, code: 0, summary });
});

test('a client whose run is about to claim an issue while npm serves a newer next-issue sees the run claim nothing and stop for an upgrade to that version, even with watching off', async (t) => {
  const registry = await fakeRegistry(t, { version: '2.1.0' });
  const { root, client } = await repoWorker(t, WORKING_GH, registry.url);
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  const asked = await client.next(
    (message) => message.type === 'runs' && message.runs[root]?.upgrade !== undefined,
  );
  assert.deepEqual(asked.type === 'runs' && asked.runs[root]!.upgrade, {
    from: '2.0.0',
    to: '2.1.0',
    resumes: true,
  });
  const { end } = await outputUntilEnd(client, root);
  assert.deepEqual(end.type === 'end' && end.summary?.issues, []);
  assert.equal(registry.asked(), 1);
});

for (const [answer, what] of [
  [{ version: '2.0.0' }, 'the same version'],
  [{ version: '1.9.0' }, 'an older version'],
  [{ status: 500 }, 'an error'],
  ['silent', 'nothing for 3 seconds'],
] as const) {
  test(`a client whose run is about to claim an issue while npm answers with ${what} sees the run claim the issue as before`, async (t) => {
    const registry = await fakeRegistry(t, answer);
    const { root, client } = await repoWorker(t, WORKING_GH, registry.url);
    client.send({ type: 'start', root, args: ['--watch', 'off'] });
    const { end } = await outputUntilEnd(client, root);
    assert.deepEqual(
      end.type === 'end' && end.summary?.issues.map((report) => [report.issue, report.outcome]),
      [[1, 'skipped']],
    );
    assert.equal(registry.asked(), 1);
  });
}

test('a client whose run is about to claim an issue while npm cannot be reached sees the run claim the issue as before', async (t) => {
  const { root, client } = await repoWorker(t, WORKING_GH, 'http://127.0.0.1:1/next-issue/latest');
  client.send({ type: 'start', root, args: ['--watch', 'off'] });
  const { end } = await outputUntilEnd(client, root);
  assert.deepEqual(
    end.type === 'end' && end.summary?.issues.map((report) => [report.issue, report.outcome]),
    [[1, 'skipped']],
  );
});
