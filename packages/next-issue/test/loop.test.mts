import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Issue } from '../src/shared/github.mts';
import type { Outcome } from '../src/shared/job.mts';
import { exitCode, type Loop, runIssues } from '../src/shared/loop.mts';
import { until } from './helpers.mts';
import { issue, report } from './loop-harness.mts';

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

test('the run handles every issue in order', async () => {
  const fake = loop({ 1: 'skipped', 2: 'done', 3: 'needs-human' });
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2, 3]);
  assert.deepEqual(
    result.reports.map((entry) => entry.outcome),
    ['skipped', 'done', 'needs-human'],
  );
  assert.equal(result.stoppedAt, undefined);
});

test('a user who asks to stop ends the run after the current issue', async () => {
  const fake = loop({ 1: 'done', 2: 'done', 3: 'done' });
  let stopped = false;
  const process = fake.process;
  fake.process = async (target) => {
    stopped = target.number === 2;
    return process(target);
  };
  fake.stop = () => stopped;
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(result.stoppedAt, 2);
});

test('a user who asks to stop before the run fetches the open issues gets no issue claimed', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  fake.stop = () => true;
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, []);
  assert.deepEqual(result.reports, []);
});

test('a user who asks to stop while the run fetches the open issues gets no issue claimed', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  let stopped = false;
  const issues = fake.issues;
  fake.issues = async () => {
    const list = await issues();
    stopped = true;
    return list;
  };
  fake.stop = () => stopped;
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, []);
  assert.deepEqual(result.reports, []);
});

test('a run ends after an issue that leaves main broken', async () => {
  const fake = loop({ 1: 'needs-human', 2: 'done' });
  fake.process = async (target) => {
    fake.processed.push(target.number);
    return { ...report(target.number, 'needs-human'), halt: true };
  };
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(result.stoppedAt, 1);
});

test('the run handles an issue opened during the run in the same run', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  const lists = [[issue(1)], [issue(1), issue(2)], [issue(1), issue(2)]];
  fake.issues = async () => lists.shift() ?? [];
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('the run does not handle an issue closed during the run', async () => {
  const fake = loop({ 1: 'done', 2: 'done', 3: 'done' });
  const lists = [[issue(1), issue(2), issue(3)], [issue(3)], []];
  fake.issues = async () => lists.shift() ?? [];
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 3]);
});

test('the run handles each issue with the details fetched just before it', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  const changed = { ...issue(2), labels: ['status:todo'] };
  const lists = [[issue(1), issue(2)], [changed], []];
  fake.issues = async () => lists.shift() ?? [];
  const handled: Issue[] = [];
  fake.process = async (target) => {
    handled.push(target);
    return report(target.number, 'done');
  };
  await runIssues(fake);
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
  const result = await runIssues(fake);
  assert.deepEqual(
    result.reports.map((entry) => entry.issue),
    [1],
  );
  assert.equal(result.error, failure);
});

test('the run exits with code 1 only when an issue needs a person or failed', () => {
  assert.equal(exitCode([report(1, 'done'), report(2, 'skipped')]), 0);
  assert.equal(exitCode([report(1, 'needs-human')]), 1);
  assert.equal(exitCode([report(1, 'error')]), 1);
  assert.equal(exitCode([report(1, 'stopped')]), 0);
  assert.equal(exitCode([]), 0);
});

function labelled(number: number, labels: string[]): Issue {
  return { ...issue(number), labels };
}

function listed(lists: Issue[][], outcomes: Outcome[]): Fake & { fetches: number } {
  const fake = { ...loop({}), fetches: 0 };
  fake.issues = async () => {
    fake.fetches += 1;
    return lists.shift() ?? [];
  };
  fake.process = async (target) => {
    fake.processed.push(target.number);
    return report(target.number, outcomes.shift()!);
  };
  return fake;
}

test('a person who answers a hand-over during the run gets the issue claimed again at the next fetch, in the usual order', async () => {
  const waiting = labelled(1, ['status:todo', 'status:needs-human']);
  const ready = labelled(1, ['status:todo']);
  const fake = listed(
    [[ready, issue(2)], [waiting, issue(2)], [ready, issue(3)], [issue(3)], []],
    ['needs-human', 'done', 'done', 'done'],
  );
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2, 1, 3]);
});

test('a person who makes a skipped issue ready during the run gets it claimed again at the next fetch', async () => {
  const blocked = labelled(1, ['status:in-progress']);
  const ready = labelled(1, ['status:todo']);
  const fake = listed(
    [[blocked, issue(2)], [blocked, issue(2)], [ready], []],
    ['skipped', 'done', 'done'],
  );
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2, 1]);
});

test('the run does not claim again an issue that comes back with the labels it had after its attempt, and ends', async () => {
  const waiting = labelled(1, ['status:todo', 'status:needs-human']);
  const fake = listed(
    [[issue(1), issue(2)], [waiting, issue(2)], [waiting], [waiting], [waiting]],
    ['needs-human', 'done'],
  );
  const result = await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(fake.fetches, 3);
  assert.equal(result.reports.length, 2);
});

test('the run does not claim again an issue that failed with an error, even when its labels change', async () => {
  const fake = listed(
    [[issue(1), issue(2)], [issue(1), issue(2)], [labelled(1, ['status:todo'])], []],
    ['error', 'done'],
  );
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('the run claims again an issue that failed with an error and was handed over, once a person makes it ready', async () => {
  const waiting = labelled(1, ['status:todo', 'status:needs-human']);
  const fake = listed(
    [[issue(1), issue(2)], [waiting, issue(2)], [labelled(1, ['status:todo'])], []],
    [],
  );
  fake.process = async (target) => {
    fake.processed.push(target.number);
    const outcome = fake.processed.length === 1 ? 'error' : 'done';
    return { ...report(target.number, outcome), handedOver: outcome === 'error' };
  };
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2, 1]);
});

test('the run does not claim again an issue that is done, even when its labels change', async () => {
  const fake = listed(
    [[issue(1), issue(2)], [issue(1), issue(2)], [labelled(1, ['status:done'])], []],
    ['done', 'done'],
  );
  await runIssues(fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

function reclaimedBlocked(
  outcome: Outcome,
  otherEnds: 'while it runs' | 'after it ends',
): Fake & { overlapped: boolean } {
  const before = labelled(1, ['status:todo']);
  const after = labelled(1, ['status:todo', 'status:ready']);
  const lists = [
    [before, issue(2)],
    [before, issue(2), issue(3)],
    [after, issue(2)],
  ];
  let endOther = (): void => {};
  const otherEnded = new Promise<void>((resolve) => {
    endOther = resolve;
  });
  const fake = { ...listed([], []), overlapped: false };
  fake.issues = async () => {
    fake.fetches += 1;
    return lists[fake.fetches - 1] ?? [after];
  };
  let running = 0;
  fake.process = async (target) => {
    fake.processed.push(target.number);
    if (target.number === 2) {
      await otherEnded;
      return report(2, 'done');
    }
    if (target.number === 3) {
      return report(3, 'skipped');
    }
    if (fake.processed.filter((number) => number === 1).length === 1) {
      return { ...report(1, 'skipped'), blocked: true };
    }
    running += 1;
    fake.overlapped ||= running > 1;
    if (otherEnds === 'while it runs') {
      endOther();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } else {
      setTimeout(endOther, 20);
    }
    running -= 1;
    return report(1, outcome);
  };
  return fake;
}

test('a person who changes the labels of a blocked issue gets it claimed once while it runs, even when another issue ends done meanwhile', async () => {
  const fake = reclaimedBlocked('done', 'while it runs');
  await runIssues({ ...fake, concurrency: 2 });
  assert.equal(fake.overlapped, false);
  assert.deepEqual(fake.processed, [1, 2, 3, 1]);
});

for (const outcome of ['done', 'error'] as const) {
  test(`a person who changes the labels of a blocked issue that then ends ${outcome} does not get it claimed again when another issue ends done`, async () => {
    const fake = reclaimedBlocked(outcome, 'after it ends');
    await runIssues({ ...fake, concurrency: 2 });
    assert.deepEqual(fake.processed, [1, 2, 3, 1]);
  });
}

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

type Counted = Fake & { open: Set<number>; status: () => number | undefined };

function counted(numbers: number[]): Counted {
  const fake = loop({}) as Counted;
  fake.open = new Set(numbers);
  let openCount: number | undefined;
  fake.status = () => openCount;
  fake.issues = async () => {
    openCount = fake.open.size;
    return [...fake.open].map((number) => issue(number));
  };
  return fake;
}

test('a person who reads the run log sees the open count drop when an issue ends while every slot is taken, and no issue is claimed for it', async () => {
  const fake = counted([1, 2, 3]);
  const secondClaimed = gate();
  const secondEnds = gate();
  const firstEnds = gate();
  fake.process = async (target, slot) => {
    fake.processed.push(target.number);
    if (target.number === 1) {
      await new Promise((resolve) => setImmediate(resolve));
      slot!.free();
      await secondClaimed.promise;
      const taken = slot!.take();
      secondEnds.open();
      await taken;
      await firstEnds.promise;
    } else if (target.number === 2) {
      secondClaimed.open();
      await secondEnds.promise;
    }
    fake.open.delete(target.number);
    return report(target.number, 'done');
  };
  const run = runIssues({ ...fake, concurrency: 1 });
  await until(() => fake.status() === 2, 'an open count of 2');
  assert.deepEqual(fake.processed, [1, 2]);
  firstEnds.open();
  await run;
  assert.deepEqual(fake.processed, [1, 2, 3]);
});

test('a person who reads the run log sees the open count drop when the run closes an issue after a stop was asked for', async () => {
  const fake = counted([1, 2]);
  let stopped = false;
  fake.process = async (target) => {
    fake.processed.push(target.number);
    fake.open.delete(target.number);
    stopped = true;
    return report(target.number, 'done');
  };
  fake.stop = () => stopped;
  const result = await runIssues(fake);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(fake.processed, [1]);
  assert.equal(fake.status(), 1);
});

test('a run whose check before a claim asks it to stop claims no issue', async () => {
  const stopping = loop({ 1: 'done', 2: 'done' });
  let stop = false;
  stopping.stop = () => stop;
  stopping.beforeClaim = async () => {
    stop = true;
  };
  await runIssues(stopping);
  assert.deepEqual(stopping.processed, []);
});

test('a run whose check before a claim changes nothing claims each issue after its check', async () => {
  const going = loop({ 1: 'done', 2: 'done' });
  const order: string[] = [];
  going.beforeClaim = async () => {
    order.push('check');
  };
  const process = going.process;
  going.process = (target, slot) => {
    order.push(`claim ${target.number}`);
    return process(target, slot);
  };
  await runIssues(going);
  assert.deepEqual(order, ['check', 'claim 1', 'check', 'claim 2']);
});
