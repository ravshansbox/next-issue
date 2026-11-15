import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { applyEvent, startProgress } from '../src/progress.mts';
import type { IssueState } from '../src/state.mts';
import { APPROVE, changes, harness, ISSUE, minor, type Plan, roles } from './harness.mts';

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
  assert.equal(kept.reviewRounds, before.reviewRounds);
  assert.equal(kept.ciFixes, 1);
  assert.deepEqual(kept.reviewLog, before.reviewLog);
  assert.equal(
    stopped.events.some((record) => record.kind === 'hand-over' || record.reason === 'no verdict'),
    false,
  );
  assert.deepEqual(stopped.comments, []);
});

test('a user who stops a run now during the reviewer of the last review round gets the round given back, and the next run reviews the change in that round with the last-round rule', async (t) => {
  const config = { maxReviewRounds: 1 };
  const first = await harness(t, { config, stopNowDuring: 'reviewer' });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = (await first.state())!;
  assert.equal(saved.reviewRounds, 0);
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    config,
    verdicts: [minor('The name is long.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.notEqual(report.reason, 'review budget');
  assert.deepEqual(roles(target), ['reviewer']);
  assert.equal(
    target.comments.some((body) => body.includes('review rounds was reached')),
    false,
  );
  assert.deepEqual(target.closed, [7]);
});

test('a user who stops a run now while the fixer of the failed checks on main runs gets the check fix given back, and the next run fixes them with no revert or hand-over', async (t) => {
  const config = { maxCiFixes: 1 };
  const first = await harness(t, { config, baseChecks: ['fail'], stopNowDuring: 'fixer' });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = (await first.state())!;
  assert.equal(saved.ciFixes, 0);
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    config,
    baseMoved: true,
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.notEqual(report.reason, 'check budget');
  assert.deepEqual(roles(target), ['fixer']);
  assert.equal((await target.state())?.handedOver, undefined);
  assert.deepEqual(target.closed, [7]);
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

async function stopDuringRead(t: TestContext, plan: Plan, read: 'openBlockers' | 'threadComments') {
  const target = await harness(t, plan);
  target.context.ports[read] = async () => {
    target.stopNow();
    throw new Error('gh issue view failed with code 130');
  };
  const report = await target.run();
  const kinds = target.events.map((record) => record.kind);
  const progress = target.events.reduce(applyEvent, startProgress());
  return { report, kinds, progress };
}

test('a user who stops a run now while the blockers of a new issue are read gets that issue ended as stopped, not failed', async (t) => {
  const { report, kinds, progress } = await stopDuringRead(t, {}, 'openBlockers');
  assert.equal(report.outcome, 'stopped');
  assert.ok(kinds.includes('issue.stop'));
  assert.ok(!kinds.includes('issue.error'));
  assert.ok(!progress.handled.some((item) => item.outcome === 'error'));
});

test('a user who stops a run now while the hand-over answer of a needs-human issue is read gets that issue ended as stopped, not failed', async (t) => {
  const issue = { ...ISSUE, labels: ['status:needs-human'] };
  const { report, kinds, progress } = await stopDuringRead(t, { issue }, 'threadComments');
  assert.equal(report.outcome, 'stopped');
  assert.ok(kinds.includes('issue.stop'));
  assert.ok(!kinds.includes('issue.error'));
  assert.ok(!progress.handled.some((item) => item.outcome === 'error'));
});

test('a user whose blockers read fails with no stop gets that issue ended as failed', async (t) => {
  const target = await harness(t);
  target.context.ports.openBlockers = async () => {
    throw new Error('gh: HTTP 500');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.ok(target.events.some((record) => record.kind === 'issue.error'));
});

test('a user who stops a run now while the hand-over answer of a resumed needs-human issue is read gets its saved review rounds and check fixes in the report', async (t) => {
  const first = await harness(t, { pressDuring: 'reviewer', verdicts: [changes('Rename it.')] });
  assert.equal((await first.run()).outcome, 'stopped');
  const saved = { ...(await first.state())!, ciFixes: 1 };
  const issue = { ...ISSUE, labels: ['status:needs-human'] };
  const { report } = await stopDuringRead(t, { saved, issue }, 'threadComments');
  assert.equal(report.outcome, 'stopped');
  assert.equal(report.reviewRounds, saved.reviewRounds);
  assert.equal(report.ciFixes, 1);
});

test('a user who stops a run now while the failed jobs on main are rerun gets the issue stopped with the check fixes kept, and the next run reruns them before any fixer', async (t) => {
  const first = await harness(t, { baseChecks: ['fail'] });
  first.context.ports.rerunFailedBase = async (_repo, sha) => {
    first.reruns.push(sha);
    first.stopNow();
    throw new Error('The run stopped.');
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.equal(
    first.events.some((record) => record.kind === 'main-checks.rerun-failed'),
    false,
  );
  const saved = (await first.state())!;
  assert.equal(saved.ciFixes, 0);
  assert.equal(saved.rerun, undefined);
  assert.deepEqual(saved.landed, ['2']);
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    baseMoved: true,
    baseChecks: ['fail'],
    rerunChecks: ['pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.reruns, ['2']);
  assert.deepEqual(roles(target), []);
});

test('a user who stops a run now while the harness waits for the rerun failed jobs on main to restart gets the issue stopped with the rerun kept, and the next run sends a new failure to the fixer with no second rerun', async (t) => {
  const first = await harness(t, { baseChecks: ['fail'] });
  first.context.ports.rerunFailedBase = async (_repo, sha, _branch, started) => {
    first.reruns.push(sha);
    started?.({ id: 41, attempt: 1 });
    first.stopNow();
    throw new Error('The run stopped.');
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.equal(
    first.events.some((record) => record.kind === 'main-checks.rerun-failed'),
    false,
  );
  const saved = (await first.state())!;
  assert.equal(saved.ciFixes, 0);
  assert.equal(saved.rerun, '2');
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    baseMoved: true,
    baseChecks: ['fail', 'pass'],
  });
  await target.run();
  assert.deepEqual(target.reruns, []);
  assert.deepEqual(roles(target), ['fixer']);
});

test('a user who stops a run now after GitHub applied the done label, before the close, gets the next run to close the issue and remove its state, worktree and branch with no new push or hand-over', async (t) => {
  const first = await harness(t, { stopNowOnLabel: 'status:done' });
  assert.equal((await first.run()).outcome, 'stopped');
  assert.deepEqual(first.closed, []);
  const saved = await first.state();
  const target = await harness(t, { saved, issue: { ...ISSUE, labels: ['status:done'] } });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.closed, [7]);
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ['7']);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, '7'), undefined);
  assert.deepEqual(roles(target), []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.comments, []);
});

test('a user who stops a run now after the issue is closed, before its state file goes away, gets the next run to remove its state, worktree and branches with no new push, label, close or hand-over', async (t) => {
  const first = await harness(t, { disputes: ['7-dispute'] });
  first.context.ports.disputeBranches = async () => {
    first.stopNow();
    throw new Error('The run stopped.');
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.deepEqual(first.closed, [7]);
  const saved = await first.state();
  assert.equal(saved?.closing, true);
  const closedIssue = { ...ISSUE, labels: ['status:done'] };
  const target = await harness(t, {
    saved,
    open: [],
    closed: [closedIssue],
    disputes: ['7-dispute'],
  });
  const issues = await pendingIssues(target.context);
  assert.deepEqual(
    issues.map((entry) => entry.number),
    [7],
  );
  const report = await processIssue(target.context, issues[0]!);
  assert.equal(report.outcome, 'done');
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ['7', '7-dispute']);
  assert.equal(await target.context.ports.findWorktree(target.context.repo, '7'), undefined);
  assert.deepEqual(target.closed, []);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.comments, []);
});

test('a user whose issue was handed over after a failed close gets the next run to leave it waiting for a person, with no new close or hand-over', async (t) => {
  const first = await harness(t);
  first.context.ports.closeIssue = async () => {
    throw new Error('gh: HTTP 502');
  };
  assert.equal((await first.run()).outcome, 'error');
  const saved = await first.state();
  assert.equal(saved?.handedOver, true);
  const target = await harness(t, {
    saved,
    issue: { ...ISSUE, labels: ['status:done', 'status:needs-human'] },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.closed, []);
  assert.deepEqual(target.labels, []);
  assert.deepEqual(target.comments, []);
});
