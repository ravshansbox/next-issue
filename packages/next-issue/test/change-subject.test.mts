import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness } from './harness.mts';

const IMPLEMENTED = 'Done.\ncommit: feat: add the flag (closes #7)';

test('a user whose change gets a review fix sees it land under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: [IMPLEMENTED],
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: 'Done.\ncommit: test: cover the empty input',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages.at(-2)!, /^test: cover the empty input\n/);
  assert.equal(target.messages.at(-1)!, 'feat: add the flag\n\nRefs #7');
});

test('a user whose review fixer gives no subject sees the change land under the subject of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: [IMPLEMENTED],
    verdicts: [changes('The count is wrong.'), APPROVE],
    fixerText: 'Done.',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.messages.at(-1)!, 'feat: add the flag\n\nRefs #7');
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
  assert.deepEqual(target.reapplies, ['feat: add the flag\n\nRefs #7']);
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
  assert.equal(target.messages.at(-1)!, 'fix: repair main\n\nRefs #7');
  assert.deepEqual(target.reapplies, ['feat: add the flag\n\nRefs #7']);
});
