import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import type { Fields } from '../src/shared/observe.mts';
import { runsDir } from '../src/shared/state.mts';
import { onOff } from '../src/shared/switch.mts';
import { applyEvent, startProgress } from '../src/worker/progress.mts';
import { runRepo } from '../src/worker/run.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

const listed = JSON.stringify([
  {
    number: 5,
    title: 'Blocked',
    body: '',
    createdAt: '2026-01-01T00:00:00Z',
    labels: [{ name: 'status:todo' }, { name: 'status:blocked' }],
  },
]);

async function runWithFailedRead(
  t: TestContext,
  watch: 'on' | 'off',
): Promise<{ code: number; waits: number; records: Fields[]; events: Fields[] }> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/unreadable.git'], {
    cwd: root,
  });
  const marker = join(await tempDir(), 'read-failed');
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list")
    if [ ! -e '${marker}' ]; then
      touch '${marker}'
      echo 'error connecting to api.github.com' >&2
      exit 1
    fi
    echo '${listed}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  let waits = 0;
  const events: Fields[] = [];
  const code = await runRepo(root, parseArgs(['start', '--watch', watch]), {
    interrupts: {
      afterIssue: () => false,
      afterRound: () => false,
      sleep: async () => (waits += 1) < 2,
    },
    watching: onOff(watch === 'on'),
    output: () => undefined,
    onEvent: (record) => events.push(record),
  });
  const log = (await readdir(runsDir(root))).find((name) => name.endsWith('.jsonl'))!;
  const records = (await readFile(join(runsDir(root), log), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Fields);
  return { code, waits, records, events };
}

test('a user whose watching run cannot read the open issues sees the run log the error, wait and claim the issue on the next read', async (t) => {
  const { code, waits, records } = await runWithFailedRead(t, 'on');
  const kinds = records.map((record) => record.kind);
  const unreadable = records.find((record) => record.kind === 'issues.unreadable');
  assert.ok(unreadable);
  assert.match(String(unreadable.error), /error connecting to api\.github\.com/);
  assert.equal(kinds.includes('issues.fail'), false);
  assert.ok(kinds.indexOf('watch.wait') > kinds.indexOf('issues.unreadable'));
  assert.ok(
    records.some((record) => record.kind === 'issue.skip' && record.issue === 5),
    'issue 5 claimed after the failed read',
  );
  assert.equal(waits, 2);
  assert.equal(code, 0);
});

test('a worker client whose watching run cannot read the open issues sees the run status stay running', async (t) => {
  const { events } = await runWithFailedRead(t, 'on');
  const progress = events.reduce(applyEvent, startProgress());
  assert.equal(progress.status, 'running');
  assert.equal(progress.error, undefined);
});

test('a user whose run with --watch off cannot read the open issues sees the run end with issues.fail and exit code 1', async (t) => {
  const { code, waits, records } = await runWithFailedRead(t, 'off');
  const failure = records.find((record) => record.kind === 'issues.fail');
  assert.ok(failure);
  assert.match(String(failure.error), /error connecting to api\.github\.com/);
  assert.equal(waits, 0);
  assert.equal(code, 1);
});
