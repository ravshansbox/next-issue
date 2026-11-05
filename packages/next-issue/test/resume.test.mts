import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { STATE_DIR } from '../src/state.mts';
import { changes, harness, ISSUE, roles, SAVED, stages } from './harness.mts';

const IN_PROGRESS = { ...ISSUE, labels: ['status:in-progress'] };
const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };

test('a user who resumes a run that died after the merge gets the merge carried on without a second pull request', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: SAVED,
    merge: true,
    alreadyMerged: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.pr, 101);
  assert.deepEqual(target.titles, []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.merged, []);
  assert.deepEqual(roles(target), []);
  assert.deepEqual(target.baseWaits, ['merge-of-101']);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.equal(await target.state(), undefined);
});

test('a user who resumes a merged run whose checks on main fail gets the fix through a new pull request', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: SAVED,
    merge: true,
    alreadyMerged: true,
    baseChecks: ['fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.pr, 101);
  assert.deepEqual(target.baseWaits, ['merge-of-101', 'merge-of-101']);
  assert.deepEqual(roles(target), ['fixer', 'reviewer']);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.titles.length, 1);
});

test('a user who resumes without --merge a pull request that a person merged gets the issue done without a wait on main', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: SAVED,
    alreadyMerged: true,
    baseChecks: ['fail'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.baseWaits, []);
  assert.deepEqual(roles(target), []);
  assert.equal(target.pushes, 0);
  assert.deepEqual(target.titles, []);
  assert.deepEqual(target.reopened, []);
  assert.equal(target.labels.at(-1)!.label, 'status:done');
  assert.equal(await target.state(), undefined);
});

test('a user who resumes a run that died in the fix of main gets the fix carried on without another check fix', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, ciFixes: 1, baseFix: { sha: 'merge-of-101', head: '-1' } },
    merge: true,
    alreadyMerged: true,
    commits: [false],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.equal(target.resets, 0);
  assert.equal(target.forcedPushes, 1);
  assert.deepEqual(target.reopened, [7]);
  assert.equal(target.titles.length, 1);
  assert.deepEqual(roles(target), ['fixer', 'reviewer']);
  assert.deepEqual(
    stages(target).filter((stage) => /\//.test(stage)),
    ['checks fix 1/5', 'review 1/5'],
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
    saved: { ...SAVED, handedOver: true },
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
    saved: { ...SAVED, handedOver: true },
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
    saved: { ...SAVED, handedOver: true },
    merge: true,
    mergeFails: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  const state = await target.state();
  assert.equal(state?.handedOver, true);
  assert.equal(state?.ciFixes, 0);
});

test('a handed-over issue that still has the needs-human label is not claimed', async (t) => {
  const saved = { ...SAVED, handedOver: true };
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'skipped');
  assert.deepEqual(target.labels, []);
  assert.deepEqual(await target.state(), saved);
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
  const folder = join(target.context.repo.root, STATE_DIR);
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
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{}');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json does not hold a valid state/);
  assert.deepEqual(roles(target), []);
});

test('a user who resumes an implemented issue gets the pull request titled with the saved subject', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: { ...SAVED, phase: 'implemented', pr: undefined, title: 'feat: add the saved flag' },
  });
  await target.run();
  assert.deepEqual(target.titles, ['feat: add the saved flag']);
});

test('a user who resumes from a state file without a title gets a conventional pull request title', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: { ...SAVED, phase: 'implemented', pr: undefined },
  });
  await target.run();
  assert.deepEqual(target.titles, ['fix: resolve issue #7']);
});

test('a saved state carries on and does not implement again', async (t) => {
  const target = await harness(t, {
    issue: IN_PROGRESS,
    saved: {
      issue: 7,
      phase: 'review',
      branch: 'issue-7',
      pr: 101,
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
