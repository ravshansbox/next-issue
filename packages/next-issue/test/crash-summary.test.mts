import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import type { Fields } from '../src/shared/observe.mts';
import { runRepo } from '../src/worker/run.mts';
import type { RunSummary } from '../src/shared/summary.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';
import { writeScripts, serveBase } from './helpers.mts';

const runs = [
  { argv: ['start', '--watch', 'off'], description: 'a user whose run crashes on one issue' },
  {
    argv: ['start', '--watch', 'on'],
    description: 'a user whose watch run crashes on one issue',
  },
];

for (const { argv, description } of runs) {
  test(`${description} still gets the run end and a summary of the issues that finished`, async (t) => {
    const root = await tempDir();
    await must('git', ['init', '-q'], { cwd: root });
    await writeScripts(root, ['format', 'lint', 'typecheck', 'test']);
    await must('git', ['remote', 'add', 'origin', 'git@github.com:acme/crash.git'], {
      cwd: root,
    });
    await serveBase(root);
    await mkdir(join(root, '.next-issue'), { recursive: true });
    await writeFile(
      join(root, '.next-issue', 'config.json'),
      JSON.stringify({ labels: { ready: 'status:todo' } }),
    );
    const issues = [1, 2].map((number) => ({
      number,
      title: `issue ${number}`,
      body: '',
      createdAt: `2026-01-0${number}T00:00:00Z`,
      labels: [],
    }));
    await installGh(
      t,
      await tempDir(),
      `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '${JSON.stringify(issues)}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
    );
    const records: Fields[] = [];
    await assert.rejects(
      runRepo(root, parseArgs(argv), {
        interrupts: {
          afterIssue: () => false,
          afterRound: () => false,
          sleep: async () => false,
        },
        onEvent: (record) => {
          records.push(record);
          if (record.kind === 'issue.skip' && record.issue === 2) {
            throw new Error('issue 2 crashed');
          }
        },
      }),
      /issue 2 crashed/,
    );
    assert.ok(records.some((record) => record.kind === 'run.end'));
    const runs = join(root, '.next-issue', 'runs');
    const summaryFile = (await readdir(runs)).find((name) => name.endsWith('.summary.json'));
    assert.ok(summaryFile);
    const summary = JSON.parse(await readFile(join(runs, summaryFile), 'utf8')) as RunSummary;
    assert.deepEqual(
      summary.issues.map((report) => [report.issue, report.outcome]),
      [[1, 'skipped']],
    );
  });
}
