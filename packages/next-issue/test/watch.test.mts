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
    process: async (target, claimed) => {
      fake.processed.push(target.number);
      done.add(target.number);
      const outcome = lists[pass]![target.number - 1]!;
      if (outcome !== 'skipped') {
        claimed?.();
      }
      return report(target.number, outcome);
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

type FakeHunter = { steps: string[]; counts: number[]; idle: Promise<void> };

function hunter(
  fake: FakeWatch,
  readyLists: number[][],
  cap = 1,
  results: Array<'filed' | 'failed' | 'none'> = [],
): FakeHunter {
  const steps: string[] = [];
  const counts: number[] = [];
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
    hunt: async (count) => {
      counts.push(count);
      const outcome = results.shift() ?? 'filed';
      steps.push(outcome === 'filed' ? 'hunt' : `hunt ${outcome}`);
      return outcome === 'filed';
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      if (checks > readyLists.length) {
        await new Promise((done) => signal.addEventListener('abort', done));
      }
    },
  };
  return { steps, counts, idle };
}

function holdIssues(fake: FakeWatch, until: Promise<void>): void {
  const process = fake.process;
  fake.process = async (target, claimed) => {
    const processed = process(target, claimed);
    await until;
    return processed;
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
  fake.hunter!.ready = async (running, failed) => {
    await started;
    return ready(running, failed);
  };
  const process = fake.process;
  fake.process = async (target) => {
    resolve();
    await hunting.idle;
    return process(target);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, ['hunt', 'wait 1']);
  assert.deepEqual(hunting.counts, [1]);
});

test('a user who watches with --hunt sees the hunter told which issues run, so it can count the issues they block', async () => {
  const fake = watcher([['done']]);
  const { promise: started, resolve } = deferred();
  const hunting = hunter(fake, [[]]);
  const ready = fake.hunter!.ready;
  const seen: number[][] = [];
  fake.hunter!.ready = async (running, failed) => {
    await started;
    seen.push([...running]);
    return ready(running, failed);
  };
  const process = fake.process;
  fake.process = async (target) => {
    resolve();
    await hunting.idle;
    return process(target);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(seen[0], [1]);
});

test('a user who watches with --hunt sees the hunter told which issues failed earlier in the run, so it leaves them out of the count', async () => {
  const fake = watcher([['error'], []]);
  const { promise: failedPass, resolve } = deferred();
  const hunting = hunter(fake, [[]]);
  const ready = fake.hunter!.ready;
  const seen: number[][] = [];
  fake.hunter!.ready = async (running, failed) => {
    await failedPass;
    seen.push([...failed]);
    return ready(running, failed);
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    resolve();
    await hunting.idle;
    return wait(minutes);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(seen[0], [1]);
});

test('a user who watches with --hunt sees each hunt asked to file up to huntCap less the ready issues that are not running', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], [7], [7, 8]], 3);
  holdIssues(fake, hunting.idle);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.counts, [3, 2, 1]);
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
  const hunting = hunter(fake, [[], [], [], []], 1, ['failed', 'failed', 'filed', 'failed']);
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

test('a user who watches with --hunt sees the hunter wait with the back-off after each hunt that files nothing, and back at 1 minute after a hunt that files an issue', async () => {
  const fake = watcher([['done']]);
  const hunting = hunter(fake, [[], [], [], [], []], 1, ['none', 'none', 'none', 'filed', 'none']);
  holdIssues(fake, hunting.idle);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, [
    'hunt none',
    'wait 1',
    'hunt none',
    'wait 2',
    'hunt none',
    'wait 3',
    'hunt',
    'hunt none',
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

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

type WakeHunter = { steps: string[]; blocked: Promise<void>; hunted: Promise<void> };

function wakeable(fake: FakeWatch, readyLists: number[][], blockFrom = 0): WakeHunter {
  const steps: string[] = [];
  const blocked = deferred();
  const hunted = deferred();
  const claimed = deferred();
  const settled = deferred();
  let checks = 0;
  let waits = 0;
  fake.hunter = {
    cap: 1,
    ready: async () => {
      const numbers = readyLists[checks] ?? [100];
      checks += 1;
      steps.push(`ready ${numbers.length}`);
      return numbers.map(issue);
    },
    hunt: async () => {
      steps.push('hunt');
      hunted.resolve();
      await Promise.race([claimed.promise, sleep(50)]);
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      waits += 1;
      if (waits <= blockFrom) {
        return;
      }
      if (checks >= readyLists.length) {
        settled.resolve();
      }
      blocked.resolve();
      if (!signal.aborted) {
        await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      }
      steps.push('wait over');
    },
  };
  const process = fake.process;
  fake.process = async (target, ring) => {
    const processed = process(target, ring);
    claimed.resolve();
    await Promise.race([settled.promise, sleep(200)]);
    return processed;
  };
  return { steps, blocked: blocked.promise, hunted: hunted.promise };
}

function claimAfter(fake: FakeWatch, moment: Promise<void>): void {
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    await moment;
    return wait(minutes);
  };
}

test('a user who watches with --hunt sees a claim end the hunter wait at once, and the hunter check the ready count again and hunt', async () => {
  const fake = watcher([[], ['done']]);
  const hunting = wakeable(fake, [[7], []]);
  claimAfter(fake, hunting.blocked);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, [
    'ready 1',
    'wait 1',
    'wait over',
    'ready 0',
    'hunt',
    'wait 1',
    'wait over',
  ]);
});

test('a user who watches with --hunt sees a claim during a hunt skip the wait after that hunt, and the hunter check the ready count again', async () => {
  const fake = watcher([[], ['done']]);
  const hunting = wakeable(fake, [[], [7]]);
  claimAfter(fake, hunting.hunted);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, ['ready 0', 'hunt', 'ready 1', 'wait 1', 'wait over']);
});

test('a user who watches with --hunt sees a claim wake the hunter, which waits again with the same back-off while huntCap issues stay ready', async () => {
  const fake = watcher([[], ['done']]);
  const hunting = wakeable(fake, [[7], [7], [7]], 1);
  claimAfter(fake, hunting.blocked);
  await watchIssues(ARGS, fake);
  assert.deepEqual(hunting.steps, [
    'ready 1',
    'wait 1',
    'ready 1',
    'wait 2',
    'wait over',
    'ready 1',
    'wait 2',
    'wait over',
  ]);
});

test('a user who watches with --hunt sees passes that each skip an issue during a hunt not wake the hunter, which waits 1, 2, 3, 5, 10, 10 minutes', async () => {
  const fake = watcher(Array.from({ length: 6 }, () => ['skipped']));
  let hunting = deferred();
  let skipped = deferred();
  let waited = deferred();
  const steps: string[] = [];
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => {
      steps.push('hunt');
      const seen = skipped;
      hunting.resolve();
      await Promise.race([seen.promise, sleep(50)]);
      return false;
    },
    wait: async (minutes, signal) => {
      steps.push(`wait ${minutes}`);
      waited.resolve();
      if (steps.length >= 12 && !signal.aborted) {
        await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      }
    },
  };
  const process = fake.process;
  fake.process = async (target, claimed) => {
    await hunting.promise;
    hunting = deferred();
    const processed = await process(target, claimed);
    skipped.resolve();
    skipped = deferred();
    return processed;
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    await Promise.race([waited.promise, sleep(50)]);
    waited = deferred();
    return wait(minutes);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(
    steps,
    [1, 2, 3, 5, 10, 10].flatMap((minutes) => ['hunt', `wait ${minutes}`]),
  );
});

test('a user who watches with --hunt sees passes that each skip an issue during a hunter wait not wake the hunter, which waits 1, 2, 3, 5, 10, 10 minutes', async () => {
  const fake = watcher(Array.from({ length: 6 }, () => ['skipped']));
  const waits: number[] = [];
  let hunterWaiting = deferred();
  let skipped = deferred();
  fake.hunter = {
    cap: 1,
    ready: async () => [],
    hunt: async () => false,
    wait: async (minutes, signal) => {
      waits.push(minutes);
      hunterWaiting.resolve();
      const aborted = new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      await Promise.race([skipped.promise, aborted]);
    },
  };
  const process = fake.process;
  fake.process = async (target, claimed) => {
    await hunterWaiting.promise;
    hunterWaiting = deferred();
    const processed = await process(target, claimed);
    skipped.resolve();
    skipped = deferred();
    return processed;
  };
  const wait = fake.wait;
  fake.wait = async (minutes) => {
    await hunterWaiting.promise;
    return wait(minutes);
  };
  await watchIssues(ARGS, fake);
  assert.deepEqual(waits, [1, 2, 3, 5, 10, 10, 10]);
});
