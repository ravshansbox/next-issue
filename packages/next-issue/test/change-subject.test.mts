import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, ISSUE } from './harness.mts';

const IMPLEMENTED = 'Done.\ncommit: feat: add the flag (closes #7)';

test('a user whose change gets a review fix sees it land under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: [IMPLEMENTED],
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: 'Done.\ncommit: test: cover the empty input',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages.at(-2)!, /^test: cover the empty input \(#7\)$/);
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user whose review fixer gives no subject sees the change land under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: [IMPLEMENTED],
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: 'Done.',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user whose reviewed change is reverted on the base branch gets it reapplied under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: [IMPLEMENTED],
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: ['Done.\ncommit: test: cover the empty input', 'unrelated: the server is down'],
    baseChecks: ['fail'],
  });
  const report = await target.run();
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.reapplies, ['feat: add the flag (#7)']);
});

test('a user whose landed check fix is reverted on the base branch gets the change reapplied under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 1 },
    implementerText: [IMPLEMENTED],
    fixerText: 'Done.\ncommit: fix: repair main',
    baseChecks: ['fail', 'fail'],
  });
  const report = await target.run();
  assert.equal(report.reason, 'check budget');
  assert.equal(target.messages.at(-1)!, 'fix: repair main (#7)');
  assert.deepEqual(target.reapplies, ['feat: add the flag (#7)']);
});

async function retry(t: Parameters<typeof harness>[0], first: Awaited<ReturnType<typeof harness>>) {
  const saved = await first.state();
  const target = await harness(t, { saved, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  target.context.ports.isOnBase = async () => false;
  assert.equal((await target.run()).outcome, 'done');
  return target;
}

test('a user who retries an issue whose landed check fix was reverted sees the change land under the subject of the implementer', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 1 },
    implementerText: [IMPLEMENTED],
    fixerText: 'Done.\ncommit: fix: repair main',
    baseChecks: ['fail', 'fail'],
  });
  assert.equal((await first.run()).reason, 'check budget');
  const target = await retry(t, first);
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user who retries an issue whose check fix failed to land and was reverted sees the change land under the subject of the implementer', async (t) => {
  const first = await harness(t, {
    implementerText: [IMPLEMENTED],
    fixerText: 'Done.\ncommit: fix: repair main',
    baseChecks: ['fail'],
  });
  const startMerge = first.context.ports.startMerge;
  first.context.ports.startMerge = async (...args) => {
    if (first.landed.length > 0) {
      throw new Error('git: merge failed');
    }
    return startMerge(...args);
  };
  assert.equal((await first.run()).reason, 'fix landing error');
  const target = await retry(t, first);
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user who retries an issue whose run stopped during the revert of a landed check fix sees the change land under the subject of the implementer', async (t) => {
  const first = await harness(t, {
    config: { maxCiFixes: 1 },
    implementerText: [IMPLEMENTED],
    fixerText: 'Done.\ncommit: fix: repair main',
    baseChecks: ['fail', 'fail'],
    revertLandsAndStops: true,
  });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const resumed = await harness(t, { saved, issue: { ...ISSUE, labels: [] } });
  resumed.context.ports.isOnBase = async (_worktree, _base, _remote, sha) =>
    sha === saved?.reverting;
  assert.equal((await resumed.run()).reason, 'revert stopped');
  const target = await retry(t, resumed);
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user whose implementer ends the subject with an issue suffix sees the change land with only the suffix of its own issue', async (t) => {
  const target = await harness(t, {
    implementerText: ['Done.\ncommit: feat: add the flag (#12) (#7)'],
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.equal(target.messages.at(-1)!, 'feat: add the flag (#7)');
});

test('a user whose implementer gives no subject sees the change land under the issue title', async (t) => {
  const target = await harness(t, { implementerText: ['Done.'] });
  assert.equal((await target.run()).outcome, 'done');
  assert.equal(target.messages.at(-1)!, 'fix: Add a flag (#7)');
});
