import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Issue } from '../src/github.mts';
import { exitCode, type Loop, runIssues, type Watch, watchIssues } from '../src/loop.mts';
import type { IssueReport, Outcome } from '../src/pipeline.mts';

function issue(number: number): Issue {
  return { number, title: 't', body: '', createdAt: '2026-01-01T00:00:00Z', labels: [] };
}

function report(number: number, outcome: Outcome): IssueReport {
  return { issue: number, outcome, ciFixes: 0, reviewRounds: 0, ms: 0 };
}

type Fake = Loop & { processed: number[] };

function loop(outcomes: Record<number, Outcome>, stops: boolean[] = []): Fake {
  const fake: Fake = {
    processed: [],
    issues: async () => Object.keys(outcomes).map((key) => issue(Number(key))),
    process: async (target) => {
      fake.processed.push(target.number);
      return report(target.number, outcomes[target.number]!);
    },
    stop: () => stops.shift() ?? false,
  };
  return fake;
}

const ARGS = { once: false };

test('every issue is handled in order', async () => {
  const fake = loop({ 1: 'skipped', 2: 'done', 3: 'needs-human' });
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 3]);
  assert.deepEqual(
    result.reports.map((entry) => entry.outcome),
    ['skipped', 'done', 'needs-human'],
  );
  assert.equal(result.stoppedAt, undefined);
});

test('--max counts the handled issues, not the skipped ones', async () => {
  const fake = loop({ 1: 'skipped', 2: 'done', 3: 'done' });
  await runIssues({ ...ARGS, max: 1 }, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('--once stops after the first handled issue', async () => {
  const fake = loop({ 1: 'skipped', 2: 'error', 3: 'done' });
  await runIssues({ ...ARGS, once: true }, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('a user who asks to stop ends the run after the current issue', async () => {
  const fake = loop({ 1: 'done', 2: 'done', 3: 'done' }, [false, true]);
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(result.stoppedAt, 2);
});

test('a run ends after an issue that leaves main broken', async () => {
  const fake = loop({ 1: 'needs-human', 2: 'done' });
  fake.process = async (target) => {
    fake.processed.push(target.number);
    return { ...report(target.number, 'needs-human'), halt: true };
  };
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
});

test('an issue opened during the run is handled in the same run', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  const lists = [[issue(1)], [issue(1), issue(2)], [issue(1), issue(2)]];
  fake.issues = async () => lists.shift() ?? [];
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('an issue closed during the run is not handled', async () => {
  const fake = loop({ 1: 'done', 2: 'done', 3: 'done' });
  const lists = [[issue(1), issue(2), issue(3)], [issue(3)], []];
  fake.issues = async () => lists.shift() ?? [];
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 3]);
});

test('an issue that was skipped or failed is not tried again in the same run', async () => {
  const fake = loop({ 1: 'skipped', 2: 'error', 3: 'done' });
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 3]);
});

test('each issue is handled with the details fetched just before it', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  const changed = { ...issue(2), labels: ['status:todo'] };
  const lists = [[issue(1), issue(2)], [changed], []];
  fake.issues = async () => lists.shift() ?? [];
  const handled: Issue[] = [];
  fake.process = async (target) => {
    handled.push(target);
    return report(target.number, 'done');
  };
  await runIssues(ARGS, fake);
  assert.deepEqual(handled, [issue(1), changed]);
});

test('a run that cannot fetch the open issues ends with the reports of the issues it handled', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  const failure = new Error('gh failed');
  const lists = [[issue(1), issue(2)]];
  fake.issues = async () => {
    const next = lists.shift();
    if (next === undefined) {
      throw failure;
    }
    return next;
  };
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(
    result.reports.map((entry) => entry.issue),
    [1],
  );
  assert.equal(result.error, failure);
});

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

test('the exit code is 1 only when an issue needs a person or failed', () => {
  assert.equal(exitCode([report(1, 'done'), report(2, 'skipped')]), 0);
  assert.equal(exitCode([report(1, 'needs-human')]), 1);
  assert.equal(exitCode([report(1, 'error')]), 1);
  assert.equal(exitCode([report(1, 'stopped')]), 0);
  assert.equal(exitCode([]), 0);
});
