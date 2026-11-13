import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processIssue } from '../src/pipeline.mts';
import { APPROVE, harness, ISSUE, roles } from './harness.mts';

test('a user whose change is approved gets it pushed to the base branch as one commit, the issue closed and done', async (t) => {
  const target = await harness(t, { implementerText: ['Done.\ncommit: feat: add the flag'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.pr, undefined);
  assert.deepEqual(target.titles, []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.landed, ['2']);
  assert.match(target.messages.at(-1)!, /^feat: add the flag\n\nRefs #7$/);
  assert.deepEqual(target.closed, [7]);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
});

test('a user whose change is approved gets it done only after the checks of the pushed commit on the base branch pass', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['2']);
  assert.equal(report.halt, undefined);
});

test('a user whose base branch moves during the push gets the change rebased and pushed again', async (t) => {
  const target = await harness(t, { pushRejects: 1 });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.baseMerges, 2);
  assert.deepEqual(target.landed, ['3']);
  assert.equal(report.ciFixes, 0);
});

test('a user whose push to the base branch keeps failing gets the issue handed over', async (t) => {
  const target = await harness(t, { pushRejects: 3 });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'push failed');
  assert.deepEqual(target.closed, []);
});

test('a user whose checks on main fail after the landing gets the fix landed the same way', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail', 'pass'],
    fixerText: 'Done.\ncommit: fix: repair main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(target.landed, ['2', '4']);
  assert.deepEqual(target.baseWaits, ['2', '4']);
  assert.match(target.messages.at(-1)!, /^fix: repair main\n/);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.prompts[2]!.prompt, /The checks on main failed after the change landed/);
  assert.match(target.prompts[2]!.prompt, /the failed main logs/);
  assert.deepEqual(target.reverts, []);
});

test('a user whose checks on main fail for an unrelated reason gets the change reverted, the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'unrelated: the server does not mount the release',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.equal(report.halt, true);
  assert.deepEqual(target.reverts, [{ shas: ['2'], message: 'revert: issue #7\n\nRefs #7' }]);
  assert.match(
    target.comments.at(-1)!,
    /needs help: The checks on main fail for a reason this change did not cause: .* The harness reverted the change on main\./,
  );
  assert.equal((await target.state())?.landed, undefined);
  assert.deepEqual(target.closed, []);
});

test('a user whose checks on main fail with no check fix left gets the change reverted and the issue handed over', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.equal(report.halt, true);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2']],
  );
});

test('a user whose fixes on main keep failing gets every landed commit reverted', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 1 }, baseChecks: ['fail', 'fail'] });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['2', '4']],
  );
});

test('a user whose revert cannot be pushed gets the issue handed over with the landed commits kept', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 0 },
    baseChecks: ['fail'],
    revertFails: true,
  });
  await target.run();
  assert.match(target.comments.at(-1)!, /The revert of the change on main failed/);
  assert.deepEqual((await target.state())?.landed, ['2']);
});

test('a user whose checks on main do not finish in time gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { baseChecks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'main checks timeout');
  assert.equal(report.halt, true);
});

test('a user who asks to stop after the round while main is watched gets the watch finished first', async (t) => {
  const target = await harness(t, { pressDuring: 'reviewer' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['2']);
});

test('a user with several approved issues gets each landed only after the checks of the last one end', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  const ports = target.context.ports;
  const order: string[] = [];
  const waitForBaseChecks = ports.waitForBaseChecks;
  ports.waitForBaseChecks = async (...args) => {
    order.push(`wait ${args[1]}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end ${args[1]}`);
    return waitForBaseChecks(...args);
  };
  const pushToBase = ports.pushToBase;
  ports.pushToBase = async (...args) => {
    order.push('push');
    return pushToBase(...args);
  };
  const reports = await Promise.all([
    processIssue(target.context, ISSUE),
    processIssue(target.context, { ...ISSUE, number: 8 }),
  ]);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done'],
  );
  assert.equal(order.length, 6);
  assert.deepEqual(
    order.map((entry) => entry.split(' ')[0]),
    ['push', 'wait', 'end', 'push', 'wait', 'end'],
  );
});

test('a user with several issues gets the others implemented and reviewed while one waits to land', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  const ports = target.context.ports;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitForBaseChecks = ports.waitForBaseChecks;
  let first = true;
  ports.waitForBaseChecks = async (...args) => {
    if (first) {
      first = false;
      await held;
    }
    return waitForBaseChecks(...args);
  };
  const landing = processIssue(target.context, ISSUE);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const other = processIssue(target.context, { ...ISSUE, number: 8 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  release();
  const reports = await Promise.all([landing, other]);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done'],
  );
});
