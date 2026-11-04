import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, roles } from './harness.mts';

test('a lock file gives the setup command when the config holds none', async (t) => {
  const target = await harness(t, { detected: 'pnpm install --frozen-lockfile' });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.setups, ['pnpm install --frozen-lockfile']);
});

test('the config setup command wins over the lock file', async (t) => {
  const target = await harness(t, {
    config: { setupCommand: 'make deps' },
    detected: 'pnpm install --frozen-lockfile',
  });
  await target.run();
  assert.deepEqual(target.setups, ['make deps']);
});

test('a project without a lock file runs no setup', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.setups, []);
});

test('a deduced setup command that fails hands the issue to a person', async (t) => {
  const target = await harness(t, { detected: 'npm ci', setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('a setup command that fails hands the issue to a person', async (t) => {
  const target = await harness(t, { config: { setupCommand: 'npm ci' }, setupCode: 1 });
  const report = await target.run();
  assert.equal(report.reason, 'setup failed');
  assert.deepEqual(roles(target), []);
});

test('a setup command that does not finish hands the issue to a person', async (t) => {
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
