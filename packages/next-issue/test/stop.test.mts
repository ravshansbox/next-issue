import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { IssueState } from '../src/state.mts';
import { APPROVE, changes, harness, ISSUE, type Plan, roles } from './harness.mts';

test('a user who asks to stop during the implementation gets the run stopped before the push, with the state kept', async (t) => {
  const target = await harness(t, { pressDuring: 'implementer' });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer']);
  assert.equal(target.pushes, 0);
  assert.equal((await target.state())?.phase, 'implemented');
  assert.equal(target.labels.at(-1)?.label, 'status:in-progress');
});

test('a user who asks to stop during the fix of main gets the fix landed first', async (t) => {
  const target = await harness(t, { pressDuring: 'fixer', baseChecks: ['fail', 'pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.deepEqual(target.landed, ['2', '4']);
});

test('a user who asks to stop during a review round gets the fix and no next review', async (t) => {
  const target = await harness(t, {
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.equal((await target.state())?.reviewRounds, 1);
  assert.equal(target.labels.at(-1)?.label, 'status:in-review');
});

test('a user who stops a run now while a push to main lands gets the next run to await the checks of that commit with no new review', async (t) => {
  const first = await harness(t, { pushLandsAndStops: true });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const target = await harness(t, { saved, baseMoved: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.baseWaits, ['2']);
  assert.deepEqual(target.closed, [7]);
});

test('a user who stops a run now during the implementation gets the issue stopped with no hand-over and the state kept', async (t) => {
  const target = await harness(t, { stopNowDuring: 'implementer' });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.comments, []);
  assert.equal((await target.state())?.handedOver, undefined);
  assert.equal(target.labels.at(-1)?.label, 'status:in-progress');
});

test('a user who stops a run now during the second review gets the issue stopped with no hand-over, and the next run keeps the review rounds, check fixes and findings', async (t) => {
  const first = await harness(t, { pressDuring: 'reviewer', verdicts: [changes('Rename it.')] });
  assert.equal((await first.run()).outcome, 'stopped');
  const before = (await first.state())!;
  const stopped = await harness(t, {
    saved: { ...before, ciFixes: 1 },
    issue: { ...ISSUE, labels: ['status:in-review'] },
    stopNowDuring: 'reviewer',
  });
  assert.equal((await stopped.run()).outcome, 'stopped');
  const kept = (await stopped.state())!;
  assert.equal(kept.handedOver, undefined);
  assert.equal(kept.reviewRounds, before.reviewRounds + 1);
  assert.equal(kept.ciFixes, 1);
  assert.deepEqual(kept.reviewLog, before.reviewLog);
  assert.equal(
    stopped.events.some((record) => record.kind === 'hand-over' || record.reason === 'no verdict'),
    false,
  );
  assert.deepEqual(stopped.comments, []);
});

test('a user who stops a run now during the setup command gets the issue stopped with no hand-over, and the next run keeps the review rounds, fix counts and findings', async (t) => {
  const first = await harness(t, { pressDuring: 'reviewer', verdicts: [changes('Rename it.')] });
  assert.equal((await first.run()).outcome, 'stopped');
  const before = { ...(await first.state())!, ciFixes: 1, commitFixes: 1 };
  const stopped = await harness(t, {
    saved: before,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    config: { setupCommand: 'npm ci' },
    stopNowDuringSetup: true,
  });
  const report = await stopped.run();
  assert.equal(report.outcome, 'stopped');
  assert.notEqual(report.reason, 'setup failed');
  const kept = (await stopped.state())!;
  assert.equal(kept.handedOver, undefined);
  assert.equal(kept.reviewRounds, before.reviewRounds);
  assert.equal(kept.ciFixes, 1);
  assert.equal(kept.commitFixes, 1);
  assert.deepEqual(kept.reviewLog, before.reviewLog);
  assert.equal(
    stopped.events.some(
      (record) =>
        record.kind === 'setup.fail' ||
        record.kind === 'hand-over' ||
        record.reason === 'setup failed',
    ),
    false,
  );
  assert.deepEqual(stopped.comments, []);
  const next = await harness(t, {
    saved: kept,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    config: { setupCommand: 'npm ci' },
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it again.')],
  });
  assert.equal((await next.run()).outcome, 'stopped');
  const resumed = (await next.state())!;
  assert.equal(resumed.reviewRounds, before.reviewRounds + 1);
  assert.equal(resumed.ciFixes, 1);
  assert.equal(resumed.commitFixes, 1);
  assert.deepEqual(resumed.reviewLog.slice(0, before.reviewLog.length), before.reviewLog);
});

test('a user who stops a run now while a new issue is claimed, after GitHub applied the in-progress label, gets the next run to resume that issue', async (t) => {
  const first = await harness(t, { stopNowOnLabel: 'status:in-progress' });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = await first.state();
  const issue = { ...ISSUE, labels: ['status:in-progress'] };
  const target = await harness(t, { saved, issue });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
});

async function stopDuringLanding(t: TestContext, plan: Plan): Promise<IssueState> {
  const first = await harness(t, plan);
  const ports = first.context.ports;
  ports.startMerge = async () => {
    first.stopNow();
    throw new Error('The run stopped.');
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.deepEqual(first.landed, []);
  return (await first.state())!;
}

test('a user who stops a run now while a change approved in the last review round lands gets it landed by the next run with no review budget hand-over', async (t) => {
  const config = { maxReviewRounds: 1 };
  const saved = await stopDuringLanding(t, { config });
  const issue = { ...ISSUE, labels: ['status:in-review'] };
  const target = await harness(t, { saved, issue, config });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.notEqual(report.reason, 'review budget');
  assert.deepEqual(roles(target), []);
  assert.equal(target.landed.length, 1);
  assert.deepEqual(target.closed, [7]);
});

test('a user who stops a run now while a change approved in an earlier review round lands gets it landed by the next run with no new review', async (t) => {
  const saved = await stopDuringLanding(t, {});
  const issue = { ...ISSUE, labels: ['status:in-review'] };
  const target = await harness(t, { saved, issue });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), []);
  assert.equal(
    target.comments.some((body) => body.startsWith('### Review:')),
    false,
  );
  assert.equal(target.landed.length, 1);
});

test('a user whose approved change is handed over during its landing gets it reviewed again when the issue resumes', async (t) => {
  const first = await harness(t, { pushRejects: 3 });
  assert.equal((await first.run()).outcome, 'needs-human');
  const saved = (await first.state())!;
  const target = await harness(t, { saved, issue: { ...ISSUE, labels: [] } });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['reviewer']);
});
