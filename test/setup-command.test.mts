import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

test('the worker runs the setup command of the lock file when the config holds none, in the worktree and again before the local checks', async (t) => {
  const target = await harness(t, { detected: 'pnpm install --frozen-lockfile' });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.setups, [
    'pnpm install --frozen-lockfile',
    'pnpm install --frozen-lockfile',
  ]);
});

test('the worker runs the setup command of the config over that of the lock file', async (t) => {
  const target = await harness(t, {
    config: { setupCommand: 'make deps' },
    detected: 'pnpm install --frozen-lockfile',
  });
  await target.run();
  assert.deepEqual(target.setups, ['make deps', 'make deps']);
});

test('the worker runs no setup for a project without a lock file', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.setups, []);
});

test('the worker hands the issue to a person when a setup command it picked from the lock file fails', async (t) => {
  const target = await harness(t, { detected: 'npm ci', setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('the worker hands the issue to a person when the setup command fails', async (t) => {
  const target = await harness(t, { config: { setupCommand: 'npm ci' }, setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('the worker hands the issue to a person when the setup command does not finish', async (t) => {
  const target = await harness(t, {
    config: { setupCommand: 'npm ci', setupTimeoutMinutes: 5 },
    setupCode: 1,
    setupTimedOut: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'setup timeout');
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.deepEqual(roles(target), []);
});

test('a user who resumes an issue with a change landed on main and whose setup command fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: { ...SAVED, landed: ['0'] },
    config: { setupCommand: 'npm ci' },
    setupCode: 1,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'setup failed');
  assert.equal(report.halt, true);
  assert.deepEqual((await target.state())?.landed, ['0']);
  assert.match(
    target.comments.at(-1) ?? '',
    /landed commit is on `main`.*checks were not awaited/s,
  );
});

test('a user who resumes an issue with a push to main saved and whose setup command times out gets the run halted', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: { ...SAVED, pushing: '9' },
    config: { setupCommand: 'npm ci' },
    setupCode: 1,
    setupTimedOut: true,
  });
  const report = await target.run();
  assert.equal(report.reason, 'setup timeout');
  assert.equal(report.halt, true);
});

test('a user who resumes an issue whose saved revert reached main and whose setup command fails gets the run halted before main is read', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-review'] },
    saved: { ...SAVED, landed: ['2'], reverting: '3' },
    config: { setupCommand: 'npm ci' },
    setupCode: 1,
  });
  let baseReads = 0;
  target.context.ports.isOnBase = async () => {
    baseReads += 1;
    return true;
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'setup failed');
  assert.equal(report.halt, true);
  assert.deepEqual(target.reverts, []);
  assert.equal(baseReads, 0);
  assert.match(target.comments.at(-1) ?? '', /revert may be on `main`/);
});
