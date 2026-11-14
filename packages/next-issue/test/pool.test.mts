import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueReport, Outcome } from '../src/job.mts';
import { type Loop, runIssues } from '../src/loop.mts';
import { ARGS, issue, report } from './loop-harness.mts';

type Pool = Loop & {
  started: number[];
  finish: (number: number, outcome: Outcome, halt?: boolean) => Promise<void>;
};

function pool(numbers: number[], concurrency: number, stops: boolean[] = []): Pool {
  const pending = new Map<number, (value: IssueReport) => void>();
  const fake: Pool = {
    started: [],
    concurrency,
    issues: async () => numbers.map(issue),
    process: (target) =>
      new Promise((resolve) => {
        fake.started.push(target.number);
        pending.set(target.number, resolve);
      }),
    stop: () => stops.shift() ?? false,
    finish: async (number, outcome, halt) => {
      pending.get(number)!({ ...report(number, outcome), ...(halt ? { halt } : {}) });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return fake;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a user with concurrency 2 gets two issues handled at once and the next one claimed as soon as a slot frees up', async () => {
  const fake = pool([1, 2, 3, 4], 2);
  const result = runIssues(ARGS, fake);
  await settle();
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(2, 'done');
  assert.deepEqual(fake.started, [1, 2, 3]);
  await fake.finish(1, 'done');
  await fake.finish(3, 'done');
  await fake.finish(4, 'done');
  assert.deepEqual(
    (await result).reports.map((entry) => entry.issue),
    [2, 1, 3, 4],
  );
});

test('a user with concurrency 3 and --max 2 gets no more than 2 handled issues', async () => {
  const fake = pool([1, 2, 3, 4], 3);
  const result = runIssues({ ...ARGS, max: 2 }, fake);
  await settle();
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(1, 'skipped');
  assert.deepEqual(fake.started, [1, 2, 3]);
  await fake.finish(2, 'done');
  await fake.finish(3, 'done');
  assert.deepEqual(fake.started, [1, 2, 3]);
  assert.equal((await result).reports.length, 3);
});

test('a user with concurrency 2 who asks to stop gets no new claim and every running issue finished', async () => {
  const fake = pool([1, 2, 3], 2);
  let stopped = false;
  fake.stop = () => stopped;
  const result = runIssues(ARGS, fake);
  await settle();
  stopped = true;
  await fake.finish(1, 'done');
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(2, 'done');
  const end = await result;
  assert.deepEqual(
    end.reports.map((entry) => entry.issue),
    [1, 2],
  );
  assert.equal(end.stoppedAt, 1);
});

test('a user with concurrency 2 whose issue leaves main broken gets no new claim and the run ended once the running issue ends', async () => {
  const fake = pool([1, 2, 3], 2);
  const result = runIssues(ARGS, fake);
  await settle();
  await fake.finish(1, 'needs-human', true);
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(2, 'done');
  const end = await result;
  assert.equal(end.reports.length, 2);
  assert.equal(end.stoppedAt, 1);
});

test('a user with concurrency 2 who passes --once gets one handled issue and no claim after it', async () => {
  const fake = pool([1, 2, 3], 2);
  const result = runIssues({ once: true }, fake);
  await settle();
  assert.deepEqual(fake.started, [1]);
  await fake.finish(1, 'skipped');
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(2, 'done');
  assert.deepEqual(fake.started, [1, 2]);
  assert.equal((await result).reports.length, 2);
});

test('a user with concurrency 2 whose fetch fails gets no new claim and the running issue finished', async () => {
  const fake = pool([1, 2, 3], 2);
  const failure = new Error('gh failed');
  const lists = [[issue(1), issue(2), issue(3)]];
  fake.issues = async () => {
    const next = lists.shift();
    if (next === undefined) {
      throw failure;
    }
    return next;
  };
  const result = runIssues(ARGS, fake);
  await settle();
  await fake.finish(1, 'done');
  assert.deepEqual(fake.started, [1, 2]);
  await fake.finish(2, 'done');
  const end = await result;
  assert.deepEqual(
    end.reports.map((entry) => entry.issue),
    [1, 2],
  );
  assert.equal(end.error, failure);
});

test('a user with concurrency 2 whose issue is skipped while another runs does not get it tried again in that run', async () => {
  const fake = pool([1, 2], 2);
  const result = runIssues(ARGS, fake);
  await settle();
  await fake.finish(2, 'skipped');
  await fake.finish(1, 'done');
  assert.deepEqual(fake.started, [1, 2]);
  assert.equal((await result).reports.length, 2);
});

test('a user with concurrency 2 whose issue throws gets the error once the other running issue ends', async () => {
  const fake = pool([1, 2, 3], 2);
  const failure = new Error('boom');
  const process = fake.process;
  fake.process = (target) => (target.number === 1 ? Promise.reject(failure) : process(target));
  let caught: unknown;
  const result = runIssues(ARGS, fake).catch((error: unknown) => {
    caught = error;
  });
  await settle();
  assert.equal(caught, undefined);
  assert.deepEqual(fake.started, [2]);
  await fake.finish(2, 'done');
  await result;
  assert.equal(caught, failure);
  assert.deepEqual(fake.started, [2]);
});
