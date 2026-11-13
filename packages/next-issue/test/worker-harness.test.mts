import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, fakeRuns, runsOf, worker } from './worker-harness.mts';

test('a test that waits for a message the worker never sends fails with an error that names the wait', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  const client = await connect(t, socketPath);
  await assert.rejects(
    client.next((value) => value.type === 'error'),
    /timed out .*value\.type === 'error'/,
  );
});

test('a test that waits for a message the worker sends gets the message', async (t) => {
  const { socketPath } = await worker(t, fakeRuns());
  const client = await connect(t, socketPath);
  assert.deepEqual(await client.next(runsOf), { type: 'runs', runs: {} });
});
