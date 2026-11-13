import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, changes, harness, roles } from './harness.mts';

test('an implementer whose commit fails in a hook gets the hook output and commits the fix', async (t) => {
  const target = await harness(t, { commits: ['oxlint: publicProcedure is never used', true] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'implementer', 'reviewer']);
  assert.match(target.prompts[1]!.prompt, /oxlint: publicProcedure is never used/);
  assert.equal(target.landed.length, 1);
  assert.equal(report.ciFixes, 0);
});

test('an implementer whose subject a commit-msg hook rejects commits again with the subject from the fix', async (t) => {
  const target = await harness(t, {
    commits: ['commitlint: subject may not be empty', true],
    implementerText: ['commit: Bad subject', 'commit: fix: count the issues'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^Bad subject\n/);
  assert.match(target.messages[1]!, /^fix: count the issues\n/);
});

test('an implementer whose hook fix names no subject commits again with the earlier subject', async (t) => {
  const target = await harness(t, {
    commits: ['oxlint: x is never used', true],
    implementerText: ['commit: fix: count the issues', 'Fixed the lint error.'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^fix: count the issues\n/);
  assert.match(target.messages[1]!, /^fix: count the issues\n/);
});

test('a fixer whose subject a commit-msg hook rejects commits again with the subject from the fix', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'commitlint: subject may not be empty', true],
    fixerText: ['commit: Bad subject', 'commit: fix: rename the counter'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^Bad subject\n/);
  assert.match(target.messages[2]!, /^fix: rename the counter\n/);
});

test('a fixer whose commit fails in a hook gets the hook output and commits the fix', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'oxlint: x is never used', true],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'fixer', 'reviewer']);
  assert.match(target.prompts[3]!.prompt, /oxlint: x is never used/);
});

test('a commit that keeps failing in a hook hands the issue to a person once maxCommitFixes runs out', async (t) => {
  const target = await harness(t, {
    config: { maxCommitFixes: 1 },
    commits: ['lint fails', 'lint fails'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /lint fails/);
  assert.deepEqual(roles(target), ['implementer', 'implementer']);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.commitFixes, 1);
});

test('a commit that git itself refuses reports an error without a commit fix', async (t) => {
  const target = await harness(t, {
    commits: [new Error('git add -A failed with code 128: index.lock exists')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /index\.lock exists/);
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal((await target.state())?.commitFixes ?? 0, 0);
});
