import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, harness, roles } from './harness.mts';

test('a user who passes --merge gets the approved pull request merged', async (t) => {
  const target = await harness(t, { merge: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.merged, [101]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user who leaves out --merge keeps the merge', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.merged, []);
});

test('a user whose merge fails gets the issue handed over', async (t) => {
  const target = await harness(t, { merge: true, mergeFails: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge failed');
  assert.match(target.comments.at(-1)!, /needs help: The merge of the pull request failed/);
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal((await target.state())?.handedOver, true);
});

test('a user whose queued merge does not finish in time gets the issue handed over instead of done', async (t) => {
  const target = await harness(t, { merge: true, mergeQueued: true });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'not merged');
  assert.deepEqual(target.baseWaits, []);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The pull request did not merge in time, or it closed without a merge/,
  );
});

test('a user who passes --merge gets no merge while the build fails after the approval', async (t) => {
  const target = await harness(t, {
    merge: true,
    config: { maxCiFixes: 0 },
    checks: ['pass', 'fail'],
  });
  await target.run();
  assert.deepEqual(target.merged, []);
});

test('a user who passes --merge gets the issue done only after the checks on main pass', async (t) => {
  const target = await harness(t, { merge: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
  assert.equal(report.halt, undefined);
});

test('a user who leaves out --merge gets no wait for the checks on main', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.baseWaits, []);
});

test('a user whose checks on main fail after the merge gets the fix merged through a new pull request', async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.pr, 102);
  assert.deepEqual(target.merged, [101, 102]);
  assert.deepEqual(target.baseWaits, ['merge-of-101', 'merge-of-102']);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.resets, 1);
  assert.equal(target.forcedPushes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.match(target.prompts[2]!.prompt, /The checks on main failed after the merge/);
  assert.match(target.prompts[2]!.prompt, /the failed main logs/);
});

test("a user whose checks on main fail after the merge gets the new pull request titled with the subject of the fixer's commit", async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  await target.run();
  assert.deepEqual(target.titles, ['fix: work on #7', 'fix: repair main']);
});

test('a user whose checks on main fail for an unrelated reason gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    merge: true,
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.halt, true);
  assert.deepEqual(target.merged, [101]);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main fail for a reason this change did not cause/,
  );
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
});

test('a user whose checks on main fail with no check fix left gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { merge: true, config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
});

test('a user whose checks on main do not finish in time gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { merge: true, baseChecks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks timeout');
  assert.equal(report.halt, true);
});

test('a user who asks to stop after the round while main is watched gets the watch finished first', async (t) => {
  const target = await harness(t, { merge: true, pressDuring: 'reviewer' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
});
