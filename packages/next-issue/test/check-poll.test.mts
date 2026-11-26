import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CheckState, type ChecksProbe, pollChecks } from '../src/shared/check-poll.mts';
import { runChildren, stopRunChildren, withRunChildren } from '../src/shared/children.mts';
import { secondsToMs } from '../src/shared/durations.mts';
import { fakeClock } from './fake-clock.mts';

const OPTIONS = { intervalSeconds: 10, graceMs: 60_000, timeoutMs: 300_000 };

function probe(list: Array<'none' | 'some'>, watch: CheckState[]): ChecksProbe & { polls: number } {
  const state = {
    polls: 0,
    list: async () => {
      const next = list[Math.min(state.polls, list.length - 1)]!;
      state.polls += 1;
      return next;
    },
    watch: async () => watch.shift() ?? 'pass',
  };
  return state;
}

test('the worker waits out the grace time on a passing build before it reports pass', async () => {
  const target = probe(['some'], ['pass']);
  const time = fakeClock();
  assert.equal(await pollChecks(target, OPTIONS, time), 'pass');
  assert.equal(target.polls, 7);
  assert.equal(time.time, 60_000);
});

test('the worker reports fail for a check that fails after the first checks passed', async () => {
  const target = probe(['some'], ['pass', 'pass', 'fail']);
  const time = fakeClock();
  assert.equal(await pollChecks(target, OPTIONS, time), 'fail');
  assert.equal(time.time, 20_000);
});

test('the worker reports fail for a build that fails', async () => {
  assert.equal(await pollChecks(probe(['some'], ['fail']), OPTIONS, fakeClock()), 'fail');
});

test('the worker waits and asks again while a build is pending', async () => {
  const target = probe(['some'], ['pending', 'pending', 'pass']);
  const time = fakeClock();
  assert.equal(await pollChecks(target, { ...OPTIONS, graceMs: 0 }, time), 'pass');
  assert.equal(target.polls, 3);
  assert.equal(time.time, 20_000);
});

test('the worker does not read a check that starts late as no check', async () => {
  const target = probe(['none', 'none', 'some'], ['pass']);
  const time = fakeClock();
  assert.equal(await pollChecks(target, OPTIONS, time), 'pass');
  assert.equal(target.polls, 7);
  assert.equal(time.time, 60_000);
});

test('the worker reports none when no check shows up within the grace time', async () => {
  const target = probe(['none'], []);
  const time = fakeClock();
  assert.equal(await pollChecks(target, OPTIONS, time), 'none');
  assert.equal(target.polls, 7);
  assert.equal(time.time, 60_000);
});

test('the worker reports pass at the deadline for a passing build with a grace time as long as the timeout', async () => {
  const time = fakeClock();
  const options = { intervalSeconds: 15, graceMs: 60_000, timeoutMs: 60_000 };
  assert.equal(await pollChecks(probe(['some'], ['pass']), options, time), 'pass');
  assert.equal(time.time, 60_000);
});

test('the worker reports none at the deadline when no check shows up and the grace time is longer than the timeout', async () => {
  const time = fakeClock();
  const options = { intervalSeconds: 15, graceMs: 120_000, timeoutMs: 60_000 };
  assert.equal(await pollChecks(probe(['none'], []), options, time), 'none');
  assert.equal(time.time, 60_000);
});

test('the worker reports timeout for a build still pending at the deadline', async () => {
  const options = { intervalSeconds: 15, graceMs: 60_000, timeoutMs: 60_000 };
  assert.equal(
    await pollChecks(
      probe(['some'], ['pass', 'pending', 'pending', 'pending', 'pending']),
      options,
      fakeClock(),
    ),
    'timeout',
  );
});

test('the worker reports none at once when the grace time is zero', async () => {
  const target = probe(['none'], []);
  assert.equal(await pollChecks(target, { ...OPTIONS, graceMs: 0 }, fakeClock()), 'none');
  assert.equal(target.polls, 1);
});

test('the worker stops waiting for the checks at the deadline', async () => {
  const time = fakeClock();
  const target: ChecksProbe = {
    list: async () => 'some',
    watch: async () => 'pending',
  };
  assert.equal(await pollChecks(target, OPTIONS, time), 'timeout');
  assert.equal(time.time, OPTIONS.timeoutMs);
});

test('a run stopped now whose deadline passes during the wait gets the stop and not a timeout', async () => {
  const children = runChildren();
  const target: ChecksProbe = {
    list: async () => 'some',
    watch: async () => {
      stopRunChildren(children);
      return 'pending';
    },
  };
  const options = { ...OPTIONS, timeoutMs: secondsToMs(OPTIONS.intervalSeconds) };
  await assert.rejects(
    withRunChildren(children, () => pollChecks(target, options, fakeClock())),
    /The run stopped\./,
  );
});

test('the worker gives the check watch only the time that is left', async () => {
  const seen: number[] = [];
  const target: ChecksProbe = {
    list: async () => 'some',
    watch: async (timeoutMs) => {
      seen.push(timeoutMs);
      return 'pending';
    },
  };
  assert.equal(await pollChecks(target, { ...OPTIONS, timeoutMs: 25_000 }, fakeClock()), 'timeout');
  assert.deepEqual(seen, [25_000, 15_000, 5_000]);
});

test('the worker passes on a timeout from the check watch', async () => {
  assert.equal(await pollChecks(probe(['some'], ['timeout']), OPTIONS, fakeClock()), 'timeout');
});

test('the worker tries a check read again when it fails once', async () => {
  let calls = 0;
  const target: ChecksProbe = {
    list: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('network');
      }
      return 'some';
    },
    watch: async () => 'pass',
  };
  const time = fakeClock();
  assert.equal(await pollChecks(target, { ...OPTIONS, graceMs: 0 }, time), 'pass');
  assert.equal(time.time, 10_000);
});

test('the worker tries a check watch again when it fails once', async () => {
  let calls = 0;
  const target: ChecksProbe = {
    list: async () => 'some',
    watch: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('network');
      }
      return 'pass';
    },
  };
  const time = fakeClock();
  assert.equal(await pollChecks(target, { ...OPTIONS, graceMs: 0 }, time), 'pass');
  assert.equal(time.time, 10_000);
});

test('the worker passes on the error of a check read that keeps failing', async () => {
  const target: ChecksProbe = {
    list: async () => {
      throw new Error('network');
    },
    watch: async () => 'pass',
  };
  const time = fakeClock();
  await assert.rejects(pollChecks(target, OPTIONS, time), /network/);
  assert.equal(time.time, 20_000);
});
