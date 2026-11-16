import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Interrupts, listenForInterrupts } from '../src/interrupt.mts';

function listen(t: TestContext, say: (text: string) => void): Interrupts {
  const before = process.listeners('SIGINT');
  const interrupts = listenForInterrupts(say);
  const added = process.listeners('SIGINT').filter((listener) => !before.includes(listener));
  t.after(() => {
    for (const listener of added) {
      process.off('SIGINT', listener);
    }
  });
  return interrupts;
}

test('a user who presses Ctrl-C during a wait ends the wait at once', async (t) => {
  const said: string[] = [];
  const interrupts = listen(t, (text) => said.push(text));
  const waited = interrupts.sleep(60_000);
  process.emit('SIGINT');
  assert.equal(await waited, false);
  assert.deepEqual(said, ['Stopping now.']);
  assert.equal(await interrupts.sleep(60_000), false);
});

test('a user who presses Ctrl-C during a wait while a hunt runs is told the run stops after the hunt', async (t) => {
  const said: string[] = [];
  const interrupts = listen(t, (text) => said.push(text));
  const waited = interrupts.sleep(60_000, () => true);
  process.emit('SIGINT');
  assert.equal(await waited, false);
  assert.deepEqual(said, ['Stopping after the current hunt. Press Ctrl-C twice more to stop now.']);
});

test('a wait with no Ctrl-C runs to its end', async (t) => {
  const interrupts = listen(t, () => undefined);
  assert.equal(await interrupts.sleep(1), true);
});

test('a user whose one Ctrl-C press arrives as two signals within 100 ms sees it count as one press', async (t) => {
  const said: string[] = [];
  const interrupts = listen(t, (text) => said.push(text));
  process.emit('SIGINT');
  process.emit('SIGINT');
  assert.equal(interrupts.afterIssue(), true);
  assert.equal(interrupts.afterRound(), false);
  assert.deepEqual(said, [
    'Stopping after the running issues. Press Ctrl-C again to stop after the current round.',
  ]);
});

test('a wait that starts after a client already asked for a refresh ends at once', async (t) => {
  const interrupts = listen(t, () => undefined);
  const refresh = new AbortController();
  refresh.abort();
  const waited = interrupts.sleep(60_000, () => false, refresh.signal);
  const timeout = sleep(1_000).then(() => 'still waiting');
  assert.equal(await Promise.race([waited, timeout]), false);
});
