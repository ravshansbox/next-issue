import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseArgs } from '../src/args.mts';
import { must } from '../src/exec.mts';
import type { Interrupts } from '../src/interrupt.mts';
import { runRepo } from '../src/run.mts';
import { onOff, type Switch } from '../src/switch.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

async function runLogKinds(
  t: TestContext,
  argv: string[],
  interrupts: Interrupts,
  watching?: Switch,
): Promise<string[]> {
  const root = await tempDir();
  await must('git', ['init', '-q'], { cwd: root });
  await must('git', ['remote', 'add', 'origin', 'https://github.com/acme/stop.git'], {
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
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue list") echo '[]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  await runRepo(
    root,
    { ...parseArgs(argv), level: 'quiet' },
    { interrupts, output: () => undefined, ...(watching === undefined ? {} : { watching }) },
  );
  const runs = join(root, '.next-issue', 'runs');
  const log = (await readdir(runs)).find((name) => name.endsWith('.jsonl'));
  assert.ok(log);
  return (await readFile(join(runs, log), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => String((JSON.parse(line) as { kind: unknown }).kind));
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
  const kinds = await runLogKinds(t, ['start', '--watch'], stopDuringWait());
  assert.ok(kinds.includes('watch.wait'));
  assert.ok(kinds.includes('run.stop'));
  assert.ok(kinds.includes('run.end'));
});

test('a person who stops a run before it fetches issues sees a run stop in its run log', async (t) => {
  const kinds = await runLogKinds(t, ['start'], {
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
    ['start', '--watch'],
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
  const kinds = await runLogKinds(t, ['start'], {
    afterIssue: () => false,
    afterRound: () => false,
    sleep: async () => false,
  });
  assert.ok(kinds.includes('run.end'));
  assert.ok(!kinds.includes('run.stop'));
});
