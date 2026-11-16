import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/args.mts';
import { must } from '../src/exec.mts';
import type { Fields } from '../src/observe.mts';
import { runRepo } from '../src/run.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

async function startRun(t: TestContext, ready: string): Promise<Fields[]> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/ready.git'], {
    cwd: root,
  });
  await mkdir(join(root, '.next-issue'), { recursive: true });
  await writeFile(join(root, '.next-issue', 'config.json'), JSON.stringify({ labels: { ready } }));
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  const records: Fields[] = [];
  await runRepo(root, parseArgs(['start', '--watch', 'off']), {
    interrupts: { afterIssue: () => false, afterRound: () => false, sleep: async () => false },
    onEvent: (record) => {
      records.push(record);
    },
  });
  return records;
}

test('a user who starts a run with an empty labels.ready sees a warning that every open issue can be claimed', async (t) => {
  const records = await startRun(t, '');
  const warning = records.find((record) => record.kind === 'labels.ready.empty');
  assert.ok(warning);
  assert.match(String(warning.note), /every open issue can be claimed/);
});

test('a user who starts a run with labels.ready set sees no ready label warning', async (t) => {
  const records = await startRun(t, 'status:todo');
  assert.ok(records.some((record) => record.kind === 'run.start'));
  assert.equal(
    records.some((record) => record.kind === 'labels.ready.empty'),
    false,
  );
});
