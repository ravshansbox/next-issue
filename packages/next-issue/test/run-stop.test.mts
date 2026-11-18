import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/shared/args.mts';
import { must } from '../src/shared/exec.mts';
import type { Interrupts } from '../src/shared/interrupt.mts';
import type { Fields } from '../src/shared/observe.mts';
import { runRepo } from '../src/worker/run.mts';
import { onOff, type Switch } from '../src/shared/switch.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

type RunOptions = {
  watching?: Switch;
  issues?: number[];
  concurrency?: number;
  onEvent?: (record: Fields) => void;
};

async function runLogKinds(
  t: TestContext,
  argv: string[],
  interrupts: Interrupts,
  watching?: Switch,
): Promise<string[]> {
  return (await runLog(t, argv, interrupts, { watching })).map((line) => String(line.kind));
}

async function runLog(
  t: TestContext,
  argv: string[],
  interrupts: Interrupts,
  { watching, issues = [], concurrency = 1, onEvent }: RunOptions,
): Promise<Fields[]> {
  const listed = issues.map((number) => ({
    number,
    title: `issue ${number}`,
    body: '',
    createdAt: `2026-01-0${number}T00:00:00Z`,
    labels: [],
  }));
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/stop.git'], {
    cwd: root,
  });
  await mkdir(join(root, '.next-issue'), { recursive: true });
  await writeFile(
    join(root, '.next-issue', 'config.json'),
    JSON.stringify({ labels: { ready: 'status:todo' }, concurrency }),
  );
  await installGh(
    t,
    await tempDir(),
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '${JSON.stringify(listed)}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  await runRepo(root, parseArgs(argv), {
    interrupts,
    output: () => undefined,
    ...(watching === undefined ? {} : { watching }),
    ...(onEvent === undefined ? {} : { onEvent }),
  });
  const runs = join(root, '.next-issue', 'runs');
  const log = (await readdir(runs)).find((name) => name.endsWith('.jsonl'));
  assert.ok(log);
  return (await readFile(join(runs, log), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Fields);
}

function stopDuringWait(): Interrupts {
  let stopped = false;
  return {
    afterIssue: () => stopped,
    afterRound: () => false,
    sleep: async () => {
      stopped = true;
      return false;
    },
  };
}

test('a person who stops a watch run while it waits between passes sees a run stop in its run log', async (t) => {
  const kinds = await runLogKinds(t, ['start', '--watch', 'on'], stopDuringWait());
  assert.ok(kinds.includes('watch.wait'));
  assert.ok(kinds.includes('run.stop'));
  assert.ok(kinds.includes('run.end'));
});

test('a person who stops a run before it fetches issues sees a run stop in its run log', async (t) => {
  const kinds = await runLogKinds(t, ['start', '--watch', 'off'], {
    afterIssue: () => true,
    afterRound: () => false,
    sleep: async () => false,
  });
  assert.ok(kinds.includes('run.stop'));
});

test('a worker client who turns watching off during a wait sees no run stop in the run log', async (t) => {
  const watching = onOff(true);
  const kinds = await runLogKinds(
    t,
    ['start', '--watch', 'on'],
    {
      afterIssue: () => false,
      afterRound: () => false,
      sleep: async () => {
        watching.set(false);
        return false;
      },
    },
    watching,
  );
  assert.ok(kinds.includes('run.end'));
  assert.ok(!kinds.includes('run.stop'));
});

test('a user whose run ends on its own sees no run stop in its run log', async (t) => {
  const kinds = await runLogKinds(t, ['start', '--watch', 'off'], {
    afterIssue: () => false,
    afterRound: () => false,
    sleep: async () => false,
  });
  assert.ok(kinds.includes('run.end'));
  assert.ok(!kinds.includes('run.stop'));
});

function skippedIssues(lines: Fields[]): unknown[] {
  return lines.filter((line) => line.kind === 'issue.skip').map((line) => line.issue);
}

test('a person who turns watching off on a run that stopped for an upgrade after one of its issues ended sees the rest of the pass worked and no run stop in its run log', async (t) => {
  const watching = onOff(true);
  let upgrading = false;
  let upgraded = false;
  const lines = await runLog(
    t,
    ['start', '--watch', 'on'],
    {
      afterIssue: () => {
        if (!upgrading) {
          return false;
        }
        upgrading = false;
        watching.set(false);
        return true;
      },
      afterRound: () => false,
      sleep: async () => false,
    },
    {
      watching,
      issues: [1, 2, 3],
      concurrency: 2,
      onEvent: (record) => {
        if (record.kind === 'issue.skip' && !upgraded) {
          upgraded = true;
          upgrading = true;
        }
      },
    },
  );
  assert.deepEqual(skippedIssues(lines).toSorted(), [1, 2, 3]);
  assert.ok(lines.some((line) => line.kind === 'run.end'));
  assert.ok(!lines.some((line) => line.kind === 'run.stop'));
});

test('a person who stops a run that stopped for an upgrade after one of its issues ended and then turns watching off sees no more issues claimed and a run stop in its run log', async (t) => {
  const watching = onOff(true);
  let stopped = false;
  const lines = await runLog(
    t,
    ['start', '--watch', 'on'],
    {
      afterIssue: () => {
        if (stopped) {
          watching.set(false);
        }
        return stopped;
      },
      afterRound: () => false,
      sleep: async () => false,
    },
    {
      watching,
      issues: [1, 2, 3],
      concurrency: 2,
      onEvent: (record) => {
        stopped ||= record.kind === 'issue.skip';
      },
    },
  );
  assert.ok(!skippedIssues(lines).includes(3));
  assert.ok(lines.some((line) => line.kind === 'run.stop'));
});
