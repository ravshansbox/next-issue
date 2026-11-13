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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FakeHunter = { steps: string[]; idle: Promise<void> };

function hunter(
  fake: FakeWatch,
  readyLists: number[][],
  cap = 1,
  failures: boolean[] = [],
): FakeHunter {
  const steps: string[] = [];
  const { promise: idle, resolve } = deferred();
  const busy = Array.from({ length: cap }, (_, index) => issue(100 + index));
  let checks = 0;
  fake.hunter = {
    cap,
    ready: async () => {
      const numbers = readyLists[checks];
      checks += 1;
      if (numbers === undefined) {
        resolve();
        return busy;
      }
      return numbers.map(issue);
    },
    hunt: async () => {
      const failed = failures.shift() ?? false;
      steps.push(failed ? 'hunt failed' : 'hunt');
      return !failed;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      if (checks > readyLists.length) {
        await new Promise((done) => signal.addEventListener('abort', done));
      }
    },
  };
  return { steps, idle };
}

function holdIssues(fake: FakeWatch, until: Promise<void>): void {
  const process = fake.process;
  fake.process = async (target) => {
    await until;
    return process(target);
  };
}

test('a user who watches with --hunt sees the hunter hunt while an issue runs', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[]]);
  holdIssues(fake, hunting.idle);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1']);
  assert.deepEqual(fake.processed, [1]);
});

test('a user who watches with --hunt sees the hunter hunt only while fewer than huntCap issues are ready, and wait otherwise', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[7], [7, 8], [7, 8], [8]], 2);
  holdIssues(fake, hunting.idle);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1', 'wait 2', 'hunt', 'wait 1']);
});

test('a user who watches with --hunt sees the running issues left out of the ready count', async () => {
  const fake = watcher([['done']]);
  const { promise: started, resolve } = deferred();
  const hunting = hunter(fake, [[1]]);
  const ready = fake.hunter!.ready;
  fake.hunter!.ready = async () => {
    await started;
    return ready();
  };
  const process = fake.process;
  fake.process = async (target) => {
    resolve();
    await hunting.idle;
    return process(target);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1']);
});

test('a user who presses Ctrl-C during a hunt sees the watch stop after that hunt', async () => {
  const fake = watcher([['done'], ['done']]);
  const steps: string[] = [];
  let stopped = false;
  const { promise: hunted, resolve } = deferred();
  fake.stop = () => stopped;
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      steps.push('hunt start');
      stopped = true;
      resolve();
      await new Promise((done) => setTimeout(done, 10));
      steps.push('hunt end');
      return true;
    },
    wait: async () => {
      steps.push('wait');
    },
  };
  holdIssues(fake, hunted);
  const result = await watchIssues(ARGS, fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['hunt start', 'hunt end', 'watch end']);
  assert.equal(result.stoppedAt, 1);
});

test('a user who watches with --hunt sees the hunter wait with the back-off after each failed hunt, and back at 1 minute after a hunt that succeeds', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], [], [], []], 1, [true, true, false, true]);
  holdIssues(fake, hunting.idle);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, [
    'hunt failed',
    'wait 1',
    'hunt failed',
    'wait 2',
    'hunt',
    'hunt failed',
    'wait 1',
    'wait 2',
  ]);
});

test('a user whose watch ends while the hunter waits after a failed hunt sees the hunter stop', async () => {
  const fake = watcher([['done']]);
  const steps: string[] = [];
  const { promise: waiting, resolve } = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      steps.push('hunt failed');
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      resolve();
      await new Promise((done) => signal.addEventListener('abort', done));
      steps.push('wait end');
    },
  };
  holdIssues(fake, waiting);
  await watchIssues(ARGS, fake);
  steps.push('watch end');
  assert.deepEqual(steps, ['hunt failed', 'wait 1', 'wait end', 'watch end']);
});
