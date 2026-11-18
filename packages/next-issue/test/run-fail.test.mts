import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import type { Fields } from '../src/shared/observe.mts';
import { runRepo } from '../src/worker/run.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

const issues = [1, 2].map((number) => ({
  number,
  title: `issue ${number}`,
  body: '',
  createdAt: `2026-01-0${number}T00:00:00Z`,
  labels: [],
}));

async function failedRunLog(
  t: TestContext,
  repoView: string,
  onEvent: (record: Fields) => void,
  failure: RegExp,
): Promise<Fields[]> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/fail.git'], {
    cwd: root,
  });
  await mkdir(join(root, '.next-issue'), { recursive: true });
  await writeFile(
    join(root, '.next-issue', 'config.json'),
    JSON.stringify({ labels: { ready: 'status:todo' } }),
  );
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") ${repoView} ;;
  "issue list") echo '${JSON.stringify(issues)}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  await assert.rejects(
    runRepo(root, parseArgs(['start', '--watch', 'off']), {
      interrupts: { afterIssue: () => false, afterRound: () => false, sleep: async () => false },
      output: () => undefined,
      onEvent,
    }),
    failure,
  );
  const runs = join(root, '.next-issue', 'runs');
  const log = (await readdir(runs)).find((name) => name.endsWith('.jsonl'));
  assert.ok(log);
  return (await readFile(join(runs, log), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Fields);
}

test('a user whose run fails before it reads any issue sees the run fail with its error in the run log', async (t) => {
  const records = await failedRunLog(
    t,
    `echo 'not logged in' >&2; exit 1`,
    () => undefined,
    /not logged in/,
  );
  const failure = records.find((record) => record.kind === 'run.fail');
  assert.ok(failure);
  assert.match(String(failure.error), /not logged in/);
});

test('a user whose run an issue crashes sees the run fail with the crash error after the run end in the run log', async (t) => {
  const records = await failedRunLog(
    t,
    `echo '{"defaultBranchRef":{"name":"main"}}'`,
    (record) => {
      if (record.kind === 'issue.skip' && record.issue === 2) {
        throw new Error('issue 2 crashed');
      }
    },
    /issue 2 crashed/,
  );
  const kinds = records.map((record) => record.kind);
  assert.ok(kinds.indexOf('run.end') >= 0);
  assert.ok(kinds.indexOf('run.fail') > kinds.indexOf('run.end'));
  assert.equal(records.find((record) => record.kind === 'run.fail')?.error, 'issue 2 crashed');
});
