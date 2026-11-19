import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { type Args, parseArgs } from '../src/shared/args.mts';
import type { Issue } from '../src/shared/github.mts';
import { type Switch, onOff } from '../src/shared/switch.mts';
import type { LoopResult } from '../src/shared/loop.mts';
import { watchRun } from '../src/worker/run.mts';
import { until } from './helpers.mts';
import { harness, ISSUE, type Plan, roles } from './harness.mts';

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
