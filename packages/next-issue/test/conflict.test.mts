import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVE, harness, roles } from './harness.mts';

test('a user whose pull request conflicts with its base and shows no checks gets a clean merge of the base pushed with no agent, and the checks waited for again', async (t) => {
  const target = await harness(t, { checks: ['none', 'pass'], conflicts: [true] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.baseMerges, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.equal(target.pushes, 2);
  assert.equal(target.forcedPushes, 0);
  assert.equal(target.checkReads, 3);
});

test('a user whose pull request conflicts with its base in some files gets the fixer to resolve them, and the merge pushed without force', async (t) => {
  const target = await harness(t, {
    checks: ['none', 'pass'],
    conflicts: [true],
    conflictFiles: ['src/a.ts', 'README.md'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'fixer', 'reviewer']);
  const fixer = target.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /src\/a\.ts\nREADME\.md/);
  assert.match(fixer, /conflict markers/);
  assert.equal(target.pushes, 2);
  assert.equal(target.forcedPushes, 0);
  assert.equal(target.checkReads, 3);
});

test('a user whose pull request conflicts with its base after the check budget is used up gets the issue handed over with no merge', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 0 },
    checks: ['none'],
    conflicts: [true],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(target.baseMerges, 0);
  assert.deepEqual(roles(target), ['implementer']);
  assert.match(target.comments.at(-1)!, /conflicts with its base, and the limit of 0 check fixes/);
});

test('a user whose pull request keeps conflicting with its base gets the issue handed over once each attempt of the check budget is spent', async (t) => {
  const target = await harness(t, {
    config: { maxCiFixes: 2 },
    checks: ['none'],
    conflicts: [true, true, true],
  });
  const report = await target.run();
  assert.equal(report.reason, 'merge conflict');
  assert.equal(report.ciFixes, 2);
  assert.equal(target.baseMerges, 2);
});

test('a user whose fixer leaves the conflict with the base unresolved gets the issue handed over and the merge undone', async (t) => {
  const target = await harness(t, {
    checks: ['none'],
    conflicts: [true],
    conflictFiles: ['src/a.ts'],
    mergeResolved: false,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(target.mergeAborts, ['1']);
  assert.equal(target.pushes, 1);
  assert.match(target.comments.at(-1)!, /left the conflict with the base unresolved/);
});

test('a user whose fixer fails while it resolves a conflict with the base gets the merge undone', async (t) => {
  const target = await harness(t, {
    checks: ['none'],
    conflicts: [true],
    conflictFiles: ['src/a.ts'],
    fixerThrows: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the fixer timed out/);
  assert.deepEqual(target.mergeAborts, ['1']);
});

test('a user whose branch already holds the base, after a push that failed, gets the branch pushed with no hand-over', async (t) => {
  const target = await harness(t, {
    checks: ['none', 'pass'],
    conflicts: [true],
    upToDate: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 2);
  assert.deepEqual(target.mergeAborts, []);
});

test('a user whose merge of the base fails in a hook gets the hook output to the fixer and the merge committed with its subject', async (t) => {
  const target = await harness(t, {
    checks: ['none', 'pass'],
    conflicts: [true],
    mergeHook: 'commitlint: subject may not be empty',
    fixerText: 'commit: chore: merge the base',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^chore: merge origin\/main\n\nRefs #/);
  assert.match(target.messages[2]!, /^chore: merge the base\n/);
  assert.match(target.prompts.at(-2)!.prompt, /commitlint: subject may not be empty/);
});

test('a user whose pull request conflicts with its base but has passing checks gets the review', async (t) => {
  const target = await harness(t, { checks: ['pass'], conflicts: [true] });
  assert.equal((await target.run()).outcome, 'done');
  assert.equal(target.baseMerges, 0);
});

test('a user who passes --merge and whose approved pull request conflicts with its base gets the base merged and the checks waited for again before the merge', async (t) => {
  const target = await harness(t, {
    merge: true,
    conflicts: [true],
    verdicts: [APPROVE, APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.baseMerges, 1);
  assert.deepEqual(target.merged, [101]);
  assert.equal(target.checkReads, 4);
  assert.equal(target.forcedPushes, 0);
});
