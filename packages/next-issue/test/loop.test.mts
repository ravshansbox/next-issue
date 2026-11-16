import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Issue } from '../src/github.mts';
import type { Outcome } from '../src/job.mts';
import { exitCode, type Loop, runIssues } from '../src/loop.mts';
import { ARGS, issue, report } from './loop-harness.mts';

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

test('a user who asks to stop ends the run after the current issue', async () => {
  const fake = loop({ 1: 'done', 2: 'done', 3: 'done' });
  let stopped = false;
  const process = fake.process;
  fake.process = async (target) => {
    stopped = target.number === 2;
    return process(target);
  };
  fake.stop = () => stopped;
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(result.stoppedAt, 2);
});

test('a user who asks to stop before the run fetches the open issues gets no issue claimed', async () => {
  const fake = loop({ 1: 'done', 2: 'done' });
  fake.stop = () => true;
  const result = await runIssues(ARGS, fake);
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
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, []);
  assert.deepEqual(result.reports, []);
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

test('the exit code is 1 only when an issue needs a person or failed', () => {
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
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 1, 3]);
});

test('a person who makes a skipped issue ready during the run gets it claimed again at the next fetch', async () => {
  const blocked = labelled(1, ['status:in-progress']);
  const ready = labelled(1, ['status:todo']);
  const fake = listed(
    [[blocked, issue(2)], [blocked, issue(2)], [ready], []],
    ['skipped', 'done', 'done'],
  );
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 1]);
});

test('an issue that comes back with the labels it had after its attempt is not claimed again and the run ends', async () => {
  const waiting = labelled(1, ['status:todo', 'status:needs-human']);
  const fake = listed(
    [[issue(1), issue(2)], [waiting, issue(2)], [waiting], [waiting], [waiting]],
    ['needs-human', 'done'],
  );
  const result = await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
  assert.equal(fake.fetches, 3);
  assert.equal(result.reports.length, 2);
});

test('an issue that failed with an error is not claimed again in the same run even when its labels change', async () => {
  const fake = listed(
    [[issue(1), issue(2)], [issue(1), issue(2)], [labelled(1, ['status:todo'])], []],
    ['error', 'done'],
  );
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2]);
});

test('an issue that failed with an error and was handed over is claimed again once a person makes it ready', async () => {
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
  await runIssues(ARGS, fake);
  assert.deepEqual(fake.processed, [1, 2, 1]);
});

test('an issue that is done is not claimed again in the same run even when its labels change', async () => {
  const fake = listed(
    [[issue(1), issue(2)], [issue(1), issue(2)], [labelled(1, ['status:done'])], []],
    ['done', 'done'],
  );
  await runIssues(ARGS, fake);
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
  await runIssues(ARGS, { ...fake, concurrency: 2 });
  assert.equal(fake.overlapped, false);
  assert.deepEqual(fake.processed, [1, 2, 3, 1]);
});

for (const outcome of ['done', 'error'] as const) {
  test(`a person who changes the labels of a blocked issue that then ends ${outcome} does not get it claimed again when another issue ends done`, async () => {
    const fake = reclaimedBlocked(outcome, 'after it ends');
    await runIssues(ARGS, { ...fake, concurrency: 2 });
    assert.deepEqual(fake.processed, [1, 2, 3, 1]);
  });
}
