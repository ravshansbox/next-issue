import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, roles } from './harness.mts';

test('a user whose base branch moved without a conflict gets the base merged with no agent and no check fix spent', async (t) => {
  const target = await harness(t, { merges: [[]] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.match(target.messages.at(-1)!, /^fix: work on #7\n/);
});

test('a user whose change conflicts with the base branch gets the fixer to resolve it from the check budget, and the change landed', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts', 'README.md']] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  const fixer = target.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /src\/a\.ts\nREADME\.md/);
  assert.match(fixer, /conflict markers/);
  assert.equal(target.landed.length, 1);
});

test('a user whose change conflicts with the base branch after the check budget is used up gets the issue handed over with nothing landed', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, merges: [['src/a.ts']] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.mergeAborts, ['1']);
  assert.deepEqual(target.landed, []);
  assert.match(target.comments.at(-1)!, /conflicts with main, and the limit of 0 check fixes/);
});

test('a user whose fixer leaves the conflict unresolved gets the issue handed over and the merge undone', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts']], mergeResolved: false });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(target.mergeAborts, ['1']);
  assert.deepEqual(target.landed, []);
  assert.match(target.comments.at(-1)!, /left the conflict with main unresolved/);
});

test('a user whose fixer fails while it resolves a conflict gets the merge undone', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts']], fixerThrows: true });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the fixer timed out/);
  assert.deepEqual(target.mergeAborts, ['1']);
});

test('a user whose merge of the base fails in a hook gets the hook output to the fixer and the change landed with its own subject', async (t) => {
  const target = await harness(t, {
    merges: [[]],
    mergeHook: 'commitlint: subject may not be empty',
    fixerText: 'commit: chore: merge the base',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^chore: merge origin\/main\n\nRefs #/);
  assert.match(target.messages[2]!, /^chore: merge the base\n/);
  assert.match(target.messages.at(-1)!, /^fix: work on #7\n/);
  assert.match(target.prompts.at(-1)!.prompt, /commitlint: subject may not be empty/);
});
