import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { type Args, parseArgs } from '../src/args.mts';
import type { Issue } from '../src/github.mts';
import { type HuntSwitch, huntSwitch } from '../src/hunt-switch.mts';
import type { LoopResult } from '../src/loop.mts';
import { type Refresher, refresher } from '../src/refresh.mts';
import { watchRun } from '../src/run.mts';
import { harness, ISSUE, type Plan, roles } from './harness.mts';

type Running = {
  hunts: () => number;
  runs: () => number;
  passes: () => number;
  sleeps: number[];
  end: () => Promise<LoopResult>;
};

type Options = {
  hunting?: HuntSwitch;
  refresher?: Refresher;
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
  const result = watchRun(
    args,
    {
      issues: async () => {
        passes += 1;
        return (await options.issues?.()) ?? [];
      },
      process: (_issue, claimed) => {
        runs += 1;
        return target.run(claimed);
      },
      stop: () => stopped,
    },
    target.context,
    {
      interrupts: {
        afterIssue: () => stopped,
        afterRound: () => false,
        sleep: (ms, _busy, refreshed) =>
          new Promise((resolve) => {
            sleeps.push(ms / 60_000);
            wake = () => resolve(false);
            refreshed?.addEventListener('abort', () => resolve(false), { once: true });
          }),
      },
      hunting: options.hunting,
      refreshed: options.refresher?.refreshed,
    },
    async () => undefined,
  );
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
    end,
  };
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries += 1) {
    assert.ok(tries < 200, 'timed out');
    await delay(10);
  }
}

test('a worker client who turns hunting on for a run started with --watch alone sees that run hunt with its own hunter', async (t) => {
  const hunting = huntSwitch(false);
  const run = await startWatch(t, parseArgs(['start', '--watch']), { hunting });
  await delay(50);
  assert.equal(run.hunts(), 0);
  hunting.set(true);
  await until(() => run.hunts() === 1);
  await run.end();
});

test('a worker client who turns hunting off for a run started with --hunt sees that run start no new hunt', async (t) => {
  const hunting = huntSwitch(true);
  const run = await startWatch(t, parseArgs(['start', '--hunt']), { hunting });
  hunting.set(false);
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});

test('a user who runs with --hunt and no worker switch sees the run hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--hunt']));
  await until(() => run.hunts() === 1);
  await run.end();
});

test('a user who runs with --watch alone and no worker switch sees the run never hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['start', '--watch']));
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});

test('a worker client who asks a waiting watch run to refresh sees it start a new pass at once and wait 1 minute again', async (t) => {
  const refresh = refresher();
  const run = await startWatch(t, parseArgs(['start', '--watch']), { refresher: refresh });
  await until(() => run.sleeps.length === 1);
  refresh.refresh();
  await until(() => run.sleeps.length === 2);
  assert.equal(run.passes(), 2);
  assert.deepEqual(run.sleeps, [1, 1]);
  const result = await run.end();
  assert.equal(result.stoppedAt, undefined);
});

test('a worker client who asks a watch run to refresh while a pass runs leaves that pass and the next wait alone', async (t) => {
  const refresh = refresher();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await startWatch(t, parseArgs(['start', '--watch']), {
    refresher: refresh,
    issues: async () => {
      await held;
      return [];
    },
  });
  await until(() => run.passes() === 1);
  refresh.refresh();
  release();
  await until(() => run.sleeps.length === 1);
  await delay(50);
  assert.equal(run.passes(), 1);
  assert.deepEqual(run.sleeps, [1]);
  await run.end();
});

test('a person who takes the label off an issue that a watch handed over after an error sees a later pass of the same watch try it again', async (t) => {
  const refresh = refresher();
  const run = await startWatch(t, parseArgs(['start', '--watch']), {
    refresher: refresh,
    plan: { fail: 'runAgent' },
    issues: async () => [ISSUE],
  });
  await until(() => run.sleeps.length === 1);
  assert.equal(run.runs(), 1);
  refresh.refresh();
  await until(() => run.sleeps.length === 2);
  assert.equal(run.runs(), 2);
  await run.end();
});

test('a user whose watch fails on an issue before the claim sees no later pass of the same watch try it again', async (t) => {
  const refresh = refresher();
  const run = await startWatch(t, parseArgs(['start', '--watch']), {
    refresher: refresh,
    plan: { fail: 'openBlockers' },
    issues: async () => [ISSUE],
  });
  await until(() => run.sleeps.length === 1);
  assert.equal(run.runs(), 1);
  refresh.refresh();
  await until(() => run.sleeps.length === 2);
  assert.equal(run.runs(), 1);
  await run.end();
});
