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

test('--once stops after the first handled issue', async () => {
  const fake = loop({ 1: 'skipped', 2: 'error', 3: 'done' });
  await runIssues({ ...ARGS, once: true }, fake);
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

test('the exit code is 1 only when an issue needs a person or failed', () => {
  assert.equal(exitCode([report(1, 'done'), report(2, 'skipped')]), 0);
  assert.equal(exitCode([report(1, 'needs-human')]), 1);
  assert.equal(exitCode([report(1, 'error')]), 1);
  assert.equal(exitCode([report(1, 'stopped')]), 0);
  assert.equal(exitCode([]), 0);
});
