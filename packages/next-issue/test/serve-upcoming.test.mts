import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRuns, connect, noQuestions, worker } from './worker-harness.mts';

test('a client that asks for the upcoming issues of a repository gets the claimable and the blocked ones', async (t) => {
  const asked: string[] = [];
  const upcoming = {
    claimable: [{ issue: 3, title: 'Three' }],
    blocked: [{ issue: 4, title: 'Four', blockers: ['#2'] }],
  };
  const { socketPath } = await worker(
    t,
    fakeRuns(),
    '2.0.0',
    noQuestions,
    undefined,
    async (root) => {
      asked.push(root);
      return upcoming;
    },
  );
  const client = await connect(t, socketPath);
  client.send({ type: 'upcoming', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'upcoming'), {
    type: 'upcoming',
    root: '/repo',
    ...upcoming,
  });
  assert.deepEqual(asked, ['/repo']);
});

test('a client whose upcoming issues cannot be read gets an upcoming error for the repository', async (t) => {
  const { socketPath } = await worker(t, fakeRuns(), '2.0.0', noQuestions, undefined, async () => {
    throw new Error('gh: not logged in');
  });
  const client = await connect(t, socketPath);
  client.send({ type: 'upcoming', root: '/repo' });
  assert.deepEqual(await client.next((value) => value.type === 'upcoming-error'), {
    type: 'upcoming-error',
    root: '/repo',
    message: 'gh: not logged in',
  });
});
