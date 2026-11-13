import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir } from '../src/state.mts';
import { changes, harness, ISSUE, roles, SAVED } from './harness.mts';

const IN_PROGRESS = { ...ISSUE, labels: ['status:in-progress'] };
const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };
const HANDED_OVER = { ...SAVED, handedOver: true };

test('a user who resumes a run that died while the checks of a landed change ran gets the wait carried on without a second landing', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, landed: ['0'] },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.landed, []);
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.baseWaits, ['0']);
  assert.deepEqual(target.closed, [7]);
  assert.equal(await target.state(), undefined);
});

test('a user who resumes a handed-over issue whose landed change timed out after the base moved gets the wait carried on without a revert', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...HANDED_OVER, landed: ['-1'] },
    baseMoved: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.notEqual(report.reason, 'empty change');
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.baseWaits, ['-1']);
  assert.deepEqual(target.closed, [7]);
});

test('a user who resumes a landed change whose checks on main fail gets the fix landed', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, ciFixes: 0, landed: ['0'] },
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, ['0', '2']);
  assert.deepEqual(roles(target), ['fixer']);
  assert.deepEqual(target.landed, ['2']);
});

test('a user who resumes a landed change whose failed jobs were already rerun gets the fixer without a second rerun', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, ciFixes: 0, landed: ['0'], rerun: '0' },
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.reruns, []);
  assert.deepEqual(roles(target), ['fixer']);
});

test('a user who resumes a run that died after the fix of main was committed gets the fix landed without another check fix', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, ciFixes: 1, landed: ['-1'] },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.landed, ['1']);
});

test('a user who resumes a run that died after the fix of main was committed gets the change reverted and the run halted when the fix cannot be pushed', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, ciFixes: 1, landed: ['-1'] },
    pushRejects: 3,
  });
  const report = await target.run();
  assert.equal(report.reason, 'push failed');
  assert.equal(report.halt, true);
  assert.deepEqual(
    target.reverts.map((entry) => entry.shas),
    [['-1']],
  );
  assert.match(
    target.comments.at(-1)!,
    /failed 3 times\. The harness reverted the change on main\./,
  );
});

test('--reset puts the budgets back and keeps the resume point', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: SAVED,
    reset: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a user who takes the needs-human label off a handed-over issue gets the budgets put back without --reset', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: HANDED_OVER,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.equal(report.reviewRounds, 1);
  assert.deepEqual(roles(target), ['reviewer']);
});

test('a user who resumes a handed-over issue and stops the run gets the state saved without the mark', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: HANDED_OVER,
    pressDuring: 'reviewer',
    verdicts: [changes('Rename it.')],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'stopped');
  const state = await target.state();
  assert.equal(state?.handedOver, undefined);
  assert.equal(state?.ciFixes, 0);
});

test('a user who resumes a handed-over issue that is handed over again gets the mark back', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: HANDED_OVER,
    pushRejects: 3,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  const state = await target.state();
  assert.equal(state?.handedOver, true);
  assert.equal(state?.ciFixes, 0);
});

test('a handed-over issue that still has the needs-human label is not claimed', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved: HANDED_OVER,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(await target.state(), HANDED_OVER);
});

const NEEDS_HUMAN = { ...ISSUE, labels: ['status:needs-human'] };

const HAND_OVER_NOTE = { author: 'bot', body: 'next-issue needs help: No fix commit.' };

test('a person with write access who answers a handed-over issue gets the issue claimed again and the needs-human label removed', async (t) => {
  const target = await harness(t, {
    issue: NEEDS_HUMAN,
    saved: HANDED_OVER,
    thread: [HAND_OVER_NOTE, { author: 'owner', body: 'Ready, take it.' }],
    writers: ['owner', 'bot'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['reviewer']);
  assert.deepEqual(target.labels[0], {
    kind: 'issue',
    number: 7,
    label: 'status:in-progress',
  });
  assert.ok(target.removable[0]!.includes('status:needs-human'));
});

test('a handed-over issue whose only later comments come from the harness or a user without write access is not claimed', async (t) => {
  const target = await harness(t, {
    issue: NEEDS_HUMAN,
    saved: HANDED_OVER,
    thread: [
      HAND_OVER_NOTE,
      { author: 'bot', body: '### Review: approved' },
      { author: 'bot', body: '### Fixer: no change\n\nNothing to do.' },
      { author: 'stranger', body: 'Ready, take it.' },
    ],
    writers: ['bot'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(roles(target), []);
});

test('--reset leaves the state of a skipped issue alone', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved: SAVED,
    reset: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(await target.state(), SAVED);
});

test('a run that finds a corrupt state file reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = stateDir(target.context.repo.root);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{ "issue": 7');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json is not valid JSON/);
  assert.deepEqual(roles(target), []);
});

test('a run that finds a state file of the wrong shape reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = stateDir(target.context.repo.root);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{}');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json does not hold a valid state/);
  assert.deepEqual(roles(target), []);
});

test('a user who resumes an implemented issue gets the change landed with the saved subject', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: { ...SAVED, phase: 'implemented', title: 'feat: add the saved flag' },
  });
  await target.run();
  assert.match(target.messages.at(-1)!, /^feat: add the saved flag\n/);
});

test('a user who resumes from a state file without a title gets the change landed with a conventional subject', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: { ...SAVED, phase: 'implemented' },
  });
  await target.run();
  assert.match(target.messages.at(-1)!, /^fix: resolve issue #7\n/);
});

test('a saved state carries on and does not implement again', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: {
      issue: 7,
      phase: 'review',
      branch: 'issue-7',
      ciFixes: 2,
      reviewRounds: 1,
      reviewLog: [{ round: 1, findings: '- old' }],
    },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 2);
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['reviewer']);
  assert.deepEqual(target.branches, ['issue-7']);
  assert.deepEqual(target.starts, [false]);
});
