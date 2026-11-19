import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runChildren, stopRunChildren, withRunChildren } from '../src/shared/children.mts';
import {
  type CommandRecord,
  must,
  run,
  setCommandObserver,
  withDefaultTimeout,
} from '../src/shared/exec.mts';
import { tempDir } from './temp-dir.mts';

const NODE = process.execPath;

function script(body: string): string[] {
  return ['-e', body];
}

async function gone(pid: number): Promise<boolean> {
  for (let left = 40; left > 0; left -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return true;
      }
    }
    await sleep(50);
  }
  process.kill(pid, 'SIGKILL');
  return false;
}

async function written(file: string): Promise<number> {
  for (let left = 100; left > 0; left -= 1) {
    const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
    if (pid > 0) {
      return pid;
    }
    await sleep(50);
  }
  throw new Error('The child wrote no id.');
}

test('a command that the worker runs gives its code, its output and its error output', async () => {
  const result = await run(
    NODE,
    script("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
  );
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
});

test('a command that the worker runs gets the input the worker sends', async () => {
  const result = await run(NODE, script('process.stdin.pipe(process.stdout)'), { input: 'hello' });
  assert.equal(result.stdout, 'hello');
  assert.equal(result.code, 0);
});

test('the worker kills a command that passes the time limit', async () => {
  const result = await run(NODE, script('setTimeout(() => {}, 10000)'), { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('the worker keeps the default time limit of each of two commands that start together', async () => {
  const sleeper = script('setTimeout(() => {}, 3000)');
  const [short, long] = await Promise.all([
    withDefaultTimeout(100, async () => {
      await sleep(50);
      return run(NODE, sleeper);
    }),
    withDefaultTimeout(60_000, async () => {
      await sleep(50);
      return run(NODE, sleeper);
    }),
  ]);
  assert.equal(short.timedOut, true);
  assert.equal(long.timedOut, false);
  assert.equal(long.code, 0);
});

test('the worker stops a command on the time limit even when a grandchild holds the output open', async () => {
  const started = Date.now();
  const result = await run('bash', ['-lc', 'sleep 30 & sleep 30'], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test('the worker settles a command that exits at once, leaving a background job on its output, with its own code and output', async () => {
  const started = Date.now();
  const result = await run('bash', ['-c', 'echo out; echo err >&2; sleep 5 & exit 4'], {
    timeoutMs: 3000,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 4);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
  assert.ok(Date.now() - started < 1500);
});

test('the worker settles a command that exits at once, leaving a setsid process on its output, before the time limit', async () => {
  const started = Date.now();
  const result = await run('bash', ['-c', 'echo out; setsid sleep 5 & exit 0'], {
    timeoutMs: 3000,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out\n');
  assert.ok(Date.now() - started < 1500);
});

test('a user who stops a run now after its command exits, leaving a setsid process on its output, sees the step end before the time limit', async () => {
  const children = runChildren();
  const started = Date.now();
  const running = withRunChildren(children, () =>
    run('bash', ['-c', 'echo out; setsid sleep 30 & exit 0'], { timeoutMs: 60_000 }),
  );
  await sleep(50);
  stopRunChildren(children);
  const result = await running;
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'out\n');
  assert.ok(Date.now() - started < 1500);
});

test(
  'a user who stops a run now while a command traps SIGINT and SIGTERM sees SIGTERM after 10 seconds, then SIGKILL, and the step end within about 20 seconds',
  { timeout: 30_000 },
  async () => {
    const children = runChildren();
    const started = Date.now();
    const running = withRunChildren(children, () =>
      run(
        'bash',
        ['-c', "trap 'echo INT' INT; trap 'echo TERM' TERM; while :; do sleep 0.2; done"],
        {
          timeoutMs: 60_000,
        },
      ),
    );
    await sleep(200);
    stopRunChildren(children);
    const result = await running;
    const elapsed = Date.now() - started;
    assert.equal(result.stdout, 'INT\nTERM\n');
    assert.equal(result.timedOut, false);
    assert.ok(elapsed > 19_000 && elapsed < 23_000, `took ${elapsed} ms`);
  },
);

test(
  'a user who stops a run now while a command exits on SIGINT sees no SIGTERM sent to its process group',
  { timeout: 30_000 },
  async () => {
    const dir = await tempDir();
    const file = join(dir, 'term');
    const children = runChildren();
    const running = withRunChildren(children, () =>
      run(
        'bash',
        [
          '-c',
          `(trap '' INT; trap 'echo TERM > ${file}' TERM; sleep 12) >/dev/null 2>&1 & while :; do sleep 0.2; done`,
        ],
        { timeoutMs: 60_000 },
      ),
    );
    await sleep(200);
    stopRunChildren(children);
    await running;
    try {
      await sleep(13_000);
      assert.equal(await readFile(file, 'utf8').catch(() => 'none'), 'none');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  },
);

test('the worker kills a grandchild that outlives its parent on the time limit', async () => {
  const dir = await tempDir();
  const file = join(dir, 'pid');
  try {
    const result = await run('bash', ['-c', `sleep 30 & echo $! > ${file}; sleep 30`], {
      timeoutMs: 1000,
    });
    assert.equal(result.timedOut, true);
    const pid = Number((await readFile(file, 'utf8')).trim());
    assert.ok(pid > 0);
    assert.equal(await gone(pid), true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('the worker kills a background process that a command leaves behind when it exits', async () => {
  const dir = await tempDir();
  const file = join(dir, 'pid');
  try {
    const result = await run('bash', [
      '-c',
      `sleep 30 >/dev/null 2>&1 & echo $! > ${file}; exit 0`,
    ]);
    assert.equal(result.code, 0);
    const pid = Number((await readFile(file, 'utf8')).trim());
    assert.ok(pid > 0);
    assert.equal(await gone(pid), true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

async function interrupted(t: TestContext): Promise<{
  worker: ChildProcess;
  pid: number;
  stopped: () => Promise<boolean>;
}> {
  const dir = await tempDir();
  const file = join(dir, 'pid');
  const agentFile = join(dir, 'agent');
  const exec = new URL('../src/shared/exec.mts', import.meta.url).href;
  const children = new URL('../src/shared/children.mts', import.meta.url).href;
  const inner = [
    `import { writeFileSync } from "node:fs";`,
    `import { run } from ${JSON.stringify(exec)};`,
    `import { onStop, stopChildren } from ${JSON.stringify(children)};`,
    `onStop(() => writeFileSync(${JSON.stringify(agentFile)}, "stopped"));`,
    'process.once("SIGINT", () => stopChildren("SIGINT"));',
    `await run("bash", ["-lc", "echo $$ > ${file}; sleep 30"]);`,
  ].join('\n');
  const worker = spawn(NODE, ['--input-type=module', '-e', inner], { stdio: 'ignore' });
  t.after(async () => {
    worker.kill('SIGKILL');
    await rm(dir, { force: true, recursive: true });
  });
  const pid = await written(file);
  const stopped = async (): Promise<boolean> =>
    (await readFile(agentFile, 'utf8').catch(() => '')) === 'stopped';
  return { worker, pid, stopped };
}

test('a user who interrupts the worker while a command runs kills the command, stops every agent and ends the worker', async (t) => {
  const { worker, pid, stopped } = await interrupted(t);
  worker.kill('SIGINT');
  assert.deepEqual(await once(worker, 'exit'), [null, 'SIGINT']);
  assert.equal(await gone(pid), true);
  assert.equal(await stopped(), true);
});

test('the worker keeps only the tail of a long command output', async () => {
  const result = await run(NODE, script("process.stdout.write('a'.repeat(100))"), {
    tailChars: 10,
  });
  assert.equal(result.stdout, 'a'.repeat(10));
});

test('the worker keeps only the tail of a long command error output', async () => {
  const result = await run(NODE, script("process.stderr.write('b'.repeat(100))"), {
    tailChars: 10,
  });
  assert.equal(result.stderr, 'b'.repeat(10));
});

test('the worker reports a command that does not exist', async () => {
  await assert.rejects(run('next-issue-no-such-command', []), /ENOENT/);
});

test('the worker shows every command it runs to the observer', async () => {
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  try {
    await run(NODE, script('process.exit(0)'), { cwd: process.cwd() });
    await run(NODE, script("process.stderr.write(' bad \\n'); process.exit(2)"));
  } finally {
    setCommandObserver(() => undefined);
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.code, 0);
  assert.equal(seen[0]!.stderr, '');
  assert.equal(seen[0]!.timedOut, false);
  assert.equal(seen[0]!.cwd, process.cwd());
  assert.ok(seen[0]!.ms >= 0);
  assert.equal(seen[1]!.code, 2);
  assert.equal(seen[1]!.stderr, 'bad');
});

test('the worker gets the trimmed output of a command that must pass, and throws on a code that is not zero', async () => {
  assert.equal(await must(NODE, script("process.stdout.write(' text \\n')")), 'text');
  await assert.rejects(
    must(NODE, script("process.stderr.write('why'); process.exit(4)")),
    /failed with code 4: why/,
  );
});

test('the worker reports a command that must pass and passes the time limit', async () => {
  await assert.rejects(
    must(NODE, script('setTimeout(() => {}, 10000)'), { timeoutMs: 100 }),
    /did not finish in time/,
  );
});

test('the worker shows the output of a command on the error stream when asked', async () => {
  const exec = new URL('../src/shared/exec.mts', import.meta.url).href;
  const inner = `import { run } from ${JSON.stringify(exec)}; await run(process.execPath, ["-e", "process.stdout.write('shown')"], { show: true });`;
  const result = await run(NODE, ['--input-type=module', '-e', inner]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'shown');
});
