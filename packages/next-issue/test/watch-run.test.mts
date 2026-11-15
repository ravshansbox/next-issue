import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { type Args, parseArgs } from '../src/args.mts';
import { type HuntSwitch, huntSwitch } from '../src/hunt-switch.mts';
import type { LoopResult } from '../src/loop.mts';
import { watchRun } from '../src/run.mts';
import { harness, roles } from './harness.mts';

type Running = { hunts: () => number; end: () => Promise<LoopResult> };

async function startWatch(t: TestContext, args: Args, hunting?: HuntSwitch): Promise<Running> {
  const target = await harness(t);
  let stopped = false;
  let wake = (): void => undefined;
  const result = watchRun(
    args,
    { issues: async () => [], process: () => assert.fail('no issue'), stop: () => stopped },
    target.context,
    {
      interrupts: {
        afterIssue: () => stopped,
        afterRound: () => false,
        sleep: () =>
          new Promise((resolve) => {
            wake = () => resolve(false);
          }),
      },
      hunting,
    },
    async () => undefined,
  );
  const end = (): Promise<LoopResult> => {
    stopped = true;
    wake();
    return result;
  };
  t.after(end);
  return { hunts: () => roles(target).filter((role) => role === 'hunter').length, end };
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries += 1) {
    assert.ok(tries < 200, 'timed out');
    await delay(10);
  }
}

test('a worker client who turns hunting on for a run started with --watch alone sees that run hunt with its own hunter', async (t) => {
  const hunting = huntSwitch(false);
  const run = await startWatch(t, parseArgs(['--watch']), hunting);
  await delay(50);
  assert.equal(run.hunts(), 0);
  hunting.set(true);
  await until(() => run.hunts() === 1);
  await run.end();
});

test('a worker client who turns hunting off for a run started with --hunt sees that run start no new hunt', async (t) => {
  const hunting = huntSwitch(true);
  const run = await startWatch(t, parseArgs(['--hunt']), hunting);
  hunting.set(false);
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});

test('a user who runs with --hunt and no worker switch sees the run hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['--hunt']));
  await until(() => run.hunts() === 1);
  await run.end();
});

test('a user who runs with --watch alone and no worker switch sees the run never hunt', async (t) => {
  const run = await startWatch(t, parseArgs(['--watch']));
  await delay(50);
  assert.equal(run.hunts(), 0);
  await run.end();
});
