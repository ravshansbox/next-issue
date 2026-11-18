import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readState, writeState } from '../src/shared/state.mts';
import { APPROVE, harness, ISSUE, roles } from './harness.mts';

type Target = Awaited<ReturnType<typeof harness>>;

function doneLabelFails(target: Target): void {
  const setLabel = target.context.ports.setLabel;
  target.context.ports.setLabel = async (repo, kind, number, label, remove) => {
    if (label === 'status:done') {
      throw new Error('gh: HTTP 502');
    }
    return setLabel(repo, kind, number, label, remove);
  };
}

/** Lands the change, fails its done label and hands the issue over; returns the repository root. */
async function handedOverWhileClosing(t: Parameters<typeof harness>[0]): Promise<string> {
  const first = await harness(t, { verdicts: [APPROVE, APPROVE] });
  doneLabelFails(first);
  assert.equal((await first.run()).outcome, 'error');
  assert.deepEqual(first.closed, []);
  assert.equal((await first.state())?.handedOver, true);
  return first.context.repo.root;
}

test('a user whose closing issue is handed over after its done label fails, answered and stopped on resume gets the next run to resume the issue instead of closing it as done', async (t) => {
  const root = await handedOverWhileClosing(t);
  const resumed = await harness(t, {
    root,
    issue: { ...ISSUE, labels: [] },
    baseChecks: ['fail'],
    rerunDone: ['2'],
    stopNowDuring: 'fixer',
  });
  assert.equal((await resumed.run()).outcome, 'stopped');
  assert.equal((await resumed.state())?.closing, undefined);
  const next = await harness(t, {
    root,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    baseChecks: ['fail'],
    rerunDone: ['2'],
    stopNowDuring: 'fixer',
  });
  assert.equal((await next.run()).outcome, 'stopped');
  assert.deepEqual(roles(next), ['fixer']);
  assert.deepEqual(next.closed, []);
  assert.ok(!next.labels.some((entry) => entry.label === 'status:done'));
});

/** Rewrites the saved state of issue 7 in `root` with `change`. */
async function rewrite(
  root: string,
  change: (state: NonNullable<Awaited<ReturnType<typeof readState>>>) => object,
): Promise<void> {
  const repo = { owner: 'acme', name: 'tool', root };
  const state = await readState(repo, ISSUE.number);
  assert.ok(state !== undefined);
  await writeState(repo, { ...state, ...change(state) });
}

test('a user whose closing issue was handed over by an older version that kept the closing mark, answered and stopped on resume gets the next run to resume the issue instead of closing it as done', async (t) => {
  const root = await handedOverWhileClosing(t);
  await rewrite(root, () => ({ closing: true }));
  const resumed = await harness(t, {
    root,
    issue: { ...ISSUE, labels: [] },
    baseChecks: ['fail'],
    rerunDone: ['2'],
    stopNowDuring: 'fixer',
  });
  assert.equal((await resumed.run()).outcome, 'stopped');
  assert.equal((await resumed.state())?.closing, undefined);
  const next = await harness(t, {
    root,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    baseChecks: ['fail'],
    rerunDone: ['2'],
    stopNowDuring: 'fixer',
  });
  assert.equal((await next.run()).outcome, 'stopped');
  assert.deepEqual(next.closed, []);
  assert.ok(!next.labels.some((entry) => entry.label === 'status:done'));
});

test('a user whose closing issue got its needs-human label but whose hand-over died before it was saved gets the issue left waiting for an answer instead of closed as done', async (t) => {
  const root = await handedOverWhileClosing(t);
  await rewrite(root, () => ({
    handedOver: undefined,
    closing: true,
    pendingHandOver: { reason: 'label error' },
  }));
  const next = await harness(t, { root, issue: { ...ISSUE, labels: ['status:needs-human'] } });
  const report = await next.run();
  assert.notEqual(report.outcome, 'done');
  assert.deepEqual(next.closed, []);
  assert.ok(!next.labels.some((entry) => entry.label === 'status:done'));
});

test('a user whose closing issue is handed over, answered and halted on resume with an unchecked commit on main gets no other issue landed by the next run', async (t) => {
  const root = await handedOverWhileClosing(t);
  const resumed = await harness(t, { root, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  resumed.context.ports.waitForCiChecks = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  assert.equal((await resumed.run()).halt, true);
  assert.equal((await resumed.state())?.halted, true);
  const other = await harness(t, { root, issue: { ...ISSUE, number: 8 } });
  const blocked = await other.run();
  assert.equal(blocked.reason, 'base unchecked');
  assert.deepEqual(other.landed, []);
});
