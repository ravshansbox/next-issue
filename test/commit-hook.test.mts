import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { stopChildren } from '../src/shared/children.mts';
import type { IssueState } from '../src/shared/state.mts';
import { APPROVE, changes, type Harness, harness, ISSUE, roles } from './harness.mts';

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
  assert.match(target.messages[0]!, /^Bad subject \(#7\)$/);
  assert.match(target.messages[1]!, /^fix: count the issues \(#7\)$/);
});

test('an implementer whose hook fix names no subject commits again with the earlier subject', async (t) => {
  const target = await harness(t, {
    commits: ['oxlint: x is never used', true],
    implementerText: ['commit: fix: count the issues', 'Fixed the lint error.'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^fix: count the issues \(#7\)$/);
  assert.match(target.messages[1]!, /^fix: count the issues \(#7\)$/);
});

test('a fixer whose subject a commit-msg hook rejects commits again with the subject from the fix', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'commitlint: subject may not be empty', true],
    fixerText: ['commit: Bad subject', 'commit: fix: rename the counter'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^Bad subject \(#7\)$/);
  assert.match(target.messages[2]!, /^fix: rename the counter \(#7\)$/);
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

test('the worker hands the issue to a person once maxCommitFixes runs out on a commit that keeps failing in a hook', async (t) => {
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

test('the worker reports an error without a commit fix when git itself refuses a commit', async (t) => {
  const target = await harness(t, {
    commits: [new Error('git add -A failed with code 128: index.lock exists')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /index\.lock exists/);
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal((await target.state())?.commitFixes ?? 0, 0);
});

function onCommitFix(target: Harness, act: () => Promise<void>): void {
  const runAgent = target.context.ports.runAgent;
  let implementers = 0;
  target.context.ports.runAgent = async (recorder, request) => {
    if (request.name === 'implementer') {
      implementers += 1;
      if (implementers === 2) {
        await act();
      }
    }
    return runAgent(recorder, request);
  };
}

async function resumeAfterCommitFix(t: TestContext, saved: IssueState | undefined) {
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    config: { maxCommitFixes: 1 },
    commits: ['lint fails', true],
  });
  const report = await target.run();
  return { target, report };
}

test('a user who stops a run now during the commit fix of the last allowed try gets the next run to run that commit fix before any hand-over', async (t) => {
  const first = await harness(t, { config: { maxCommitFixes: 1 }, commits: ['lint fails'] });
  onCommitFix(first, async () => {
    first.stopNow();
    throw new Error('The run stopped.');
  });
  assert.equal((await first.run()).outcome, 'stopped');
  const { target, report } = await resumeAfterCommitFix(t, await first.state());
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target).slice(0, 2), ['implementer', 'implementer']);
  assert.equal(
    target.labels.some(({ label }) => label === 'status:needs-human'),
    false,
  );
});

test('a user who interrupts the worker during the commit fix of the last allowed try gets the next run to run that commit fix before any hand-over', async (t) => {
  const first = await harness(t, { config: { maxCommitFixes: 1 }, commits: ['lint fails'] });
  let started = (): void => undefined;
  const commitFix = new Promise<void>((resolve) => {
    started = resolve;
  });
  onCommitFix(first, async () => {
    started();
    await new Promise<never>(() => undefined);
  });
  const kills = t.mock.method(process, 'kill', () => true);
  void first.run();
  await commitFix;
  stopChildren('SIGINT');
  kills.mock.restore();
  const { target, report } = await resumeAfterCommitFix(t, await first.state());
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target).slice(0, 2), ['implementer', 'implementer']);
  assert.equal(
    target.labels.some(({ label }) => label === 'status:needs-human'),
    false,
  );
});
