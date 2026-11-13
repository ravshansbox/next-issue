import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Outcome } from '../src/job.mts';
import { exitCode } from '../src/loop.mts';
import { type Watch, watchIssues } from '../src/watch.mts';
import { ARGS, issue, report } from './loop-harness.mts';

type FakeWatch = Watch & { processed: number[]; waits: number[]; passes: number[][] };

function watcher(lists: Outcome[][], wakes: boolean[] = []): FakeWatch {
  let pass = 0;
  let done = new Set<number>();
  const fake: FakeWatch = {
    processed: [],
    waits: [],
    passes: [],
    issues: async () =>
      (lists[pass] ?? [])
        .map((_, index) => issue(index + 1))
        .filter((entry) => !done.has(entry.number)),
    process: async (target) => {
      fake.processed.push(target.number);
      done.add(target.number);
      return report(target.number, lists[pass]![target.number - 1]!);
    },
    stop: () => false,
    wait: async (minutes) => {
      fake.waits.push(minutes);
      pass += 1;
      done = new Set();
      return wakes.shift() ?? pass < lists.length;
    },
    passEnd: async (reports) => {
      fake.passes.push(reports.map((entry) => entry.issue));
    },
  };
  return fake;
}

test('a user who watches gets a wait that grows 1, 2, 3, 5, 10, 10 minutes while every issue is skipped', async () => {
  const fake = watcher([[], ['skipped'], [], [], [], [], []]);
  await watchIssues(ARGS, fake);
  assert.deepEqual(fake.waits, [1, 2, 3, 5, 10, 10, 10]);
  assert.deepEqual(fake.passes, []);
});

test('a user who watches sees the wait go back to 1 minute after a pass that handled an issue', async () => {
  const fake = watcher([[], [], ['done'], [], ['skipped']]);
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.waits, [1, 2, 1, 2, 3]);
  assert.deepEqual(fake.passes, [[1]]);
  assert.deepEqual(
    result.reports.map((entry) => entry.outcome),
    ['done', 'skipped'],
  );
});

test('a user who watches gets a summary for each pass that handled an issue', async () => {
  const fake = watcher([['done', 'skipped'], ['skipped'], ['needs-human']]);
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.passes, [[1, 2], [1]]);
  assert.equal(exitCode(result.reports), 1);
});

test('a user who watches with --max stops after n handled issues across passes', async () => {
  const fake = watcher([['done'], ['skipped', 'done', 'done']]);
  await watchIssues({ ...ARGS, max: 2 }, fake);
  assert.deepEqual(fake.processed, [1, 1, 2]);
  assert.deepEqual(fake.waits, [1]);
});

test('a user who watches with --once stops after the first handled issue', async () => {
  const fake = watcher([['skipped'], ['done', 'done']]);
  await watchIssues({ ...ARGS, once: true }, fake);
  assert.deepEqual(fake.processed, [1, 1]);
});

test('a user who watches sees an issue that failed tried only once across passes', async () => {
  const fake = watcher([['error', 'done'], ['error', 'done'], ['error']]);
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 2]);
  assert.deepEqual(fake.passes, [[1, 2], [2]]);
  assert.deepEqual(fake.waits, [1, 1, 2]);
  assert.equal(exitCode(result.reports), 1);
});

test('a user who presses Ctrl-C during a wait stops watching at once', async () => {
  const fake = watcher([['done'], ['done']], [false]);
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, undefined);
});

test('a user who presses Ctrl-C during an issue stops watching after that issue', async () => {
  const fake = watcher([['done', 'done'], ['done']]);
  fake.stop = () => true;
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(fake.waits, []);
});

test('a watch stops after a pass that halts the run', async () => {
  const fake = watcher([['needs-human'], ['done']]);
  const process = fake.process;
  fake.process = async (target) => ({ ...(await process(target)), halt: true });
  const result = await watchIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(fake.passes, [[1]]);
});

function hunter(fake: FakeWatch): string[] {
  const steps: string[] = [];
  fake.hunt = async () => {
    steps.push(`hunt after ${fake.processed.length}`);
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    steps.push('wait');
    return wait(minutes);
  };
  return steps;
}

test('a user who watches with --hunt sees one hunt per idle stretch, not one before each wait', async () => {
  const fake = watcher([['done'], [], ['skipped']]);
  const steps = hunter(fake);
  await watchIssues(ARGS, fake);
  assert.deepEqual(steps, ['hunt after 1', 'wait', 'wait', 'wait']);
});

test('a user who watches with --hunt sees a new hunt after a pass that handled an issue', async () => {
  const fake = watcher([[], [], ['done'], []]);
  const steps = hunter(fake);
  await watchIssues(ARGS, fake);
  assert.deepEqual(steps, ['hunt after 0', 'wait', 'wait', 'hunt after 1', 'wait', 'wait']);
});

test('a user who watches with --once sees no hunt once the issue is handled', async () => {
  const fake = watcher([['done']]);
  let hunts = 0;
  fake.hunt = async () => {
    hunts += 1;
  };
  await watchIssues({ ...ARGS, once: true }, fake);
  assert.equal(hunts, 0);
});
