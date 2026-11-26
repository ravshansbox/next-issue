import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { type Args, parseArgs } from '../src/shared/args.mts';
import type { Issue } from '../src/shared/github.mts';
import { type Switch, onOff } from '../src/shared/switch.mts';
import type { LoopResult } from '../src/shared/loop.mts';
import { statusText } from '../src/cli/switch-run.mts';
import { applyEvent, startProgress } from '../src/worker/progress.mts';
import { type RunControls, watchRun } from '../src/worker/run.mts';
import { until } from './helpers.mts';
import { harness, ISSUE, type Plan, roles } from './harness.mts';
import { connect, fakeRuns, worker } from './worker-harness.mts';

type Running = {
  hunts: () => number;
  runs: () => number;
  passes: () => number;
  sleeps: number[];
  ended: () => boolean;
  elapse: () => void;
  end: () => Promise<LoopResult>;
};

type Options = {
  hunting?: Switch;
  watching?: Switch;
  issues?: () => Promise<Issue[]>;
  plan?: Plan;
  controls?: Partial<RunControls>;
};

async function startWatch(t: TestContext, args: Args, options: Options = {}): Promise<Running> {
  const target = await harness(t, options.plan);
  let stopped = false;
  let passes = 0;
  let runs = 0;
  const sleeps: number[] = [];
  let wake = (): void => undefined;
  let elapse = (): void => undefined;
  const result = watchRun(
    args,
    {
      issues: async () => {
        passes += 1;
        return (await options.issues?.()) ?? [];
      },
      process: () => {
        runs += 1;
        return target.run();
      },
      stop: () => stopped,
    },
    target.context,
    {
      interrupts: {
        afterIssue: () => stopped,
        afterRound: () => false,
        sleep: (ms, woken) =>
          new Promise((resolve) => {
            sleeps.push(ms / 60_000);
            wake = () => resolve(false);
            elapse = () => resolve(true);
            if (woken?.aborted === true) {
              resolve(false);
            }
            woken?.addEventListener('abort', () => resolve(false), { once: true });
          }),
      },
      hunting: options.hunting,
      watching: options.watching,
      ...options.controls,
    },
    async () => undefined,
  );
  let ended = false;
  void result.finally(() => {
    ended = true;
  });
  const end = (): Promise<LoopResult> => {
    stopped = true;
    wake();
    return result;
  };
  t.after(end);
  return {
    hunts: () => roles(target).filter((role) => role === 'hunter').length,
    runs: () => runs,
    passes: () => passes,
    sleeps,
    ended: () => ended,
    elapse: () => elapse(),
    end,
  };
}

test('a worker client who turns hunting on for a run started with --watch alone sees that run hunt with its own hunter', async (t) => {
  const hunting = onOff(false);
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), { hunting });
  await delay(50);
  assert.equal(run.hunts(), 0);
  hunting.set(true);
  await until(() => run.hunts() === 1, 'the first hunt');
  await run.end();
});

test('a worker client who turns hunting off for a run started with --hunt sees that run start no new hunt', async (t) => {
  const hunting = onOff(true);
  const run = await startWatch(t, parseArgs(['start', '--hunt', 'on']), { hunting });
  hunting.set(false);
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});

test('a user who runs with --hunt and no worker switch sees the run hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--hunt', 'on']));
  await until(() => run.hunts() === 1, 'the first hunt');
  await run.end();
});

test('a user who runs with --watch alone and no worker switch sees the run never hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']));
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});

test('a person who takes the label off an issue that a watch handed over after an error sees a later pass of the same watch try it again', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), {
    plan: { fail: 'runAgent' },
    issues: async () => [ISSUE],
  });
  await until(() => run.sleeps.length === 1, 'the first wait');
  assert.equal(run.runs(), 1);
  run.elapse();
  await until(() => run.sleeps.length === 2, 'the second wait');
  assert.equal(run.runs(), 2);
  await run.end();
});

test('a user whose watch fails on an issue before the claim sees no later pass of the same watch try it again', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), {
    plan: { fail: 'openBlockers' },
    issues: async () => [ISSUE],
  });
  await until(() => run.sleeps.length === 1, 'the first wait');
  assert.equal(run.runs(), 1);
  run.elapse();
  await until(() => run.sleeps.length === 2, 'the second wait');
  assert.equal(run.runs(), 1);
  await run.end();
});

test('a worker client whose run does not watch sees it end after one pass with no wait', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--watch', 'off']), {
    watching: onOff(false),
  });
  await until(run.ended, 'the run end');
  assert.equal(run.passes(), 1);
  assert.deepEqual(run.sleeps, []);
});

test('a worker client who turns watching on during the pass of a run sees it wait for new issues after that pass', async (t) => {
  const watching = onOff(false);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await startWatch(t, parseArgs(['start', '--watch', 'off']), {
    watching,
    issues: async () => {
      await held;
      return [];
    },
  });
  await until(() => run.passes() === 1, 'the first pass');
  watching.set(true);
  release();
  await until(() => run.sleeps.length === 1, 'the first wait');
  await run.end();
});

test('a worker client who turns watching off during a wait sees the run end at once with no new pass', async (t) => {
  const watching = onOff(true);
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), { watching });
  await until(() => run.sleeps.length === 1, 'the first wait');
  watching.set(false);
  await until(run.ended, 'the run end');
  assert.equal(run.passes(), 1);
  assert.deepEqual(run.sleeps, [1]);
});

test('a user who reads the status of a watch run sees it wait to look again during the wait, then look for an issue once the wait ends', async (t) => {
  const events: Array<Record<string, unknown>> = [];
  let fetches = 0;
  let release = (): void => undefined;
  const held = new Promise<Issue[]>((resolve) => {
    release = () => resolve([]);
  });
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), {
    plan: { onEvent: (record) => events.push(record) },
    issues: async () => {
      fetches += 1;
      return fetches === 1 ? [] : held;
    },
  });
  const status = (): string =>
    statusText('1.0.0', '1.0.0', events.reduce(applyEvent, startProgress())).split('\n')[5]!;
  await until(() => run.sleeps.length === 1, 'the first wait');
  assert.equal(status(), 'issues: none, next look in 1 minute');
  run.elapse();
  await until(() => run.passes() === 2, 'the second pass');
  assert.equal(status(), 'issues: none, looking for one');
  release();
  await run.end();
});

async function workerRun(t: TestContext) {
  const fake = fakeRuns();
  const { socketPath } = await worker(t, fake);
  const client = await connect(t, socketPath);
  client.send({ type: 'start', root: '/repo' });
  await client.next((value) => value.type === 'runs' && value.runs['/repo'] !== undefined);
  const { interrupts: _interrupts, ...controls } = fake.controls();
  const start = async (id: string): Promise<void> => {
    client.send({ type: 'start', root: '/repo', id });
    await client.next((value) => value.type === 'runs' && value.id === id);
  };
  return { controls, start };
}

test('a person who runs start on a watching run that waits between passes sees it look again at once, then wait 1 minute', async (t) => {
  const { controls, start } = await workerRun(t);
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), { controls });
  await until(() => run.sleeps.length === 1, 'the first wait');
  run.elapse();
  await until(() => run.sleeps.length === 2, 'the second wait');
  await start('look');
  await until(() => run.sleeps.length === 3, 'the third wait');
  assert.equal(run.passes(), 3);
  assert.deepEqual(run.sleeps, [1, 2, 1]);
  await run.end();
});

test('a person who runs start on a watching run during a pass sees the run still wait its next back-off after that pass', async (t) => {
  const { controls, start } = await workerRun(t);
  let release = (): void => undefined;
  const held = new Promise<Issue[]>((resolve) => {
    release = () => resolve([]);
  });
  let fetches = 0;
  const run = await startWatch(t, parseArgs(['start', '--watch', 'on']), {
    controls,
    issues: async () => {
      fetches += 1;
      return fetches === 2 ? held : [];
    },
  });
  await until(() => run.sleeps.length === 1, 'the first wait');
  run.elapse();
  await until(() => run.passes() === 2, 'the second pass');
  await start('look');
  release();
  await until(() => run.sleeps.length === 2, 'the second wait');
  await delay(50);
  assert.equal(run.passes(), 2);
  assert.deepEqual(run.sleeps, [1, 2]);
  await run.end();
});

test('a worker whose npm check before a hunt stops the run sees that run check npm once and start no hunt', async (t) => {
  let checks = 0;
  let answerNpm = (): void => undefined;
  const npmAnswered = new Promise<void>((resolve) => {
    answerNpm = resolve;
  });
  const run = await startWatch(t, parseArgs(['start', '--hunt', 'on']), {
    controls: {
      beforeHunt: async () => {
        checks += 1;
        await npmAnswered;
      },
    },
  });
  await until(() => checks === 1, 'the npm check before the hunt');
  const ended = run.end();
  answerNpm();
  await ended;
  assert.equal(checks, 1);
  assert.equal(run.hunts(), 0);
});
