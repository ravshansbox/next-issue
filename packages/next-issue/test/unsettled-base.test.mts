import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueReport } from '../src/job.mts';
import { runIssues } from '../src/loop.mts';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { readState, writeState } from '../src/state.mts';
import { APPROVE, type Harness, harness, ISSUE, SAVED } from './harness.mts';

const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };

test('a user whose change lands and whose first read of its checks on main fails gets the issue handed over with the error, the landed commit kept and the run halted', async (t) => {
  const target = await harness(t, { verdicts: [APPROVE, APPROVE] });
  target.context.ports.waitForBaseChecks = async () => {
    throw new Error('gh: HTTP 401: Bad credentials');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'checks error');
  assert.equal(report.halt, true);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual((await target.state())?.landed, ['2']);
  assert.match(
    target.comments.at(-1) ?? '',
    /The read of the checks on main failed: gh: HTTP 401: Bad credentials\..*landed commit is on `main`.*checks were not awaited/s,
  );
  const other = await processIssue(target.context, { ...ISSUE, number: 8 });
  assert.equal(other.outcome, 'stopped');
  assert.equal(other.reason, 'run halted');
  assert.deepEqual(target.landed, ['2']);
});

test('a user who resumes an issue with a push to main saved and whose fetch of main fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, pushing: '9' },
    baseFetchFails: true,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.reason, 'fetch failed');
  assert.equal(report.halt, true);
  assert.equal(target.context.halted, true);
  assert.equal((await target.state())?.pushing, '9');
  assert.match(
    target.comments.at(-1) ?? '',
    /fetch failed.*a push may be on `main`.*checks were not awaited/s,
  );
});

test('a user who resumes an issue with a change landed on main and whose worktree fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, landed: ['0'] } });
  target.context.ports.addWorktree = async () => {
    throw new Error('git worktree add: disk full');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, true);
  assert.deepEqual((await target.state())?.landed, ['0']);
  assert.match(
    target.comments.at(-1) ?? '',
    /disk full.*landed commit is on `main`.*checks were not awaited/s,
  );
});

test('a user whose new issue fails with an error before anything lands gets the issue ended in error and the run kept going', async (t) => {
  const target = await harness(t);
  target.context.ports.addWorktree = async () => {
    throw new Error('git worktree add: disk full');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, undefined);
  assert.equal(target.context.halted, false);
});

test('a user who resumes an issue with a change landed on main and whose check for an unlanded fix fails gets the issue handed over and the run halted', async (t) => {
  const target = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, landed: ['0'] } });
  target.context.ports.revision = async () => '1';
  target.context.ports.isLanded = async () => {
    throw new Error('git merge-base: bad object');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, true);
  assert.deepEqual((await target.state())?.landed, ['0']);
  assert.match(
    target.comments.at(-1) ?? '',
    /bad object.*landed commit is on `main`.*checks were not awaited/s,
  );
});

const OTHER = { ...ISSUE, number: 8 };

test('a user whose run halted on a checks error gets no other issue landed by the next run until the halted commit has its checks read', async (t) => {
  const first = await harness(t, { verdicts: [APPROVE, APPROVE] });
  first.context.ports.waitForBaseChecks = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  assert.equal((await first.run()).reason, 'checks error');
  assert.match(first.comments.at(-1) ?? '', /no run lands another change until this issue resumes/);
  const root = first.context.repo.root;
  const second = await harness(t, { root, issue: OTHER });
  const blocked = await second.run();
  assert.equal(blocked.outcome, 'stopped');
  assert.equal(blocked.reason, 'base unchecked');
  assert.equal(blocked.halt, true);
  assert.deepEqual(second.landed, []);
  assert.ok(
    second.events.some(
      (record) => record['kind'] === 'land.blocked' && String(record['issues']) === '7',
    ),
  );
  const answered = await harness(t, { root, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  assert.equal((await answered.run()).outcome, 'done');
  assert.deepEqual(answered.baseWaits, ['2']);
  const third = await harness(t, { root, issue: OTHER });
  assert.equal((await third.run()).outcome, 'done');
  assert.equal(third.landed.length, 1);
});

test('a user whose run halted on a push unknown gets no other issue landed by the next run until the halted push is settled', async (t) => {
  const first = await harness(t, { pushLandsAndFails: true, baseFetchFails: true });
  assert.equal((await first.run()).reason, 'push unknown');
  const root = first.context.repo.root;
  const second = await harness(t, { root, issue: OTHER });
  const blocked = await second.run();
  assert.equal(blocked.outcome, 'stopped');
  assert.equal(blocked.reason, 'base unchecked');
  assert.deepEqual(second.landed, []);
  const answered = await harness(t, { root, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  assert.equal((await answered.run()).outcome, 'done');
  assert.deepEqual(answered.baseWaits, ['2']);
  const third = await harness(t, { root, issue: OTHER });
  assert.equal((await third.run()).outcome, 'done');
  assert.equal(third.landed.length, 1);
});

test('a user whose resume failed before it checked a landed commit gets no other issue landed by the next run', async (t) => {
  const first = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, landed: ['0'] } });
  first.context.ports.addWorktree = async () => {
    throw new Error('git worktree add: disk full');
  };
  assert.equal((await first.run()).halt, true);
  const second = await harness(t, { root: first.context.repo.root, issue: OTHER });
  assert.equal((await second.run()).reason, 'base unchecked');
  assert.deepEqual(second.landed, []);
});

test('a user who answers one of two issues halted with unchecked commits on main gets its landed commit checked and the issue done', async (t) => {
  const first = await harness(t, { verdicts: [APPROVE, APPROVE] });
  first.context.ports.waitForBaseChecks = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  assert.equal((await first.run()).reason, 'checks error');
  const root = first.context.repo.root;
  await writeState(first.context.repo, {
    ...SAVED,
    issue: 8,
    branch: 'issue-8',
    phase: 'approved',
    landed: ['5'],
    halted: true,
  });
  const answered = await harness(t, { root, issue: { ...ISSUE, labels: [] }, baseMoved: true });
  assert.equal((await answered.run()).outcome, 'done');
  assert.deepEqual(answered.baseWaits, ['2']);
});

for (const state of ['timeout', 'cancelled'] as const) {
  test(`a user whose run halted on main checks ${state} gets no other issue landed by the next run`, async (t) => {
    const first = await harness(t, { baseChecks: [state] });
    assert.equal((await first.run()).reason, `main checks ${state}`);
    assert.match(
      first.comments.at(-1) ?? '',
      /no run lands another change until this issue resumes/,
    );
    const second = await harness(t, { root: first.context.repo.root, issue: OTHER });
    assert.equal((await second.run()).reason, 'base unchecked');
    assert.deepEqual(second.landed, []);
  });
}

test('a user whose resume with a landed commit failed its setup gets no other issue landed by the next run', async (t) => {
  const first = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, landed: ['0'] },
    config: { setupCommand: 'npm ci' },
    setupCode: 1,
  });
  assert.equal((await first.run()).reason, 'setup failed');
  const second = await harness(t, { root: first.context.repo.root, issue: OTHER });
  assert.equal((await second.run()).reason, 'base unchecked');
  assert.deepEqual(second.landed, []);
});

const OLDER = { ...ISSUE, number: 5, createdAt: '2025-12-01T00:00:00Z' };

async function runLoop(target: Harness, concurrency: number): Promise<IssueReport[]> {
  const { context } = target;
  const { reports } = await runIssues(
    { once: false },
    {
      issues: () => pendingIssues(context),
      process: (issue, claimed) => processIssue(context, issue, claimed),
      stop: () => false,
      concurrency,
    },
  );
  return reports;
}

for (const concurrency of [1, 2]) {
  test(`a user who answers a halted issue while an older issue is held back by it gets the halted commit checked and the older issue landed (concurrency ${concurrency})`, async (t) => {
    const first = await harness(t, { verdicts: [APPROVE, APPROVE] });
    first.context.ports.waitForBaseChecks = async () => {
      throw new Error('gh: API rate limit exceeded');
    };
    assert.equal((await first.run()).reason, 'checks error');
    const root = first.context.repo.root;
    await writeState(first.context.repo, {
      ...SAVED,
      issue: 5,
      branch: 'issue-5',
      phase: 'approved',
    });
    const answered = { ...ISSUE, labels: [] };
    let blocked = (): void => undefined;
    const landBlocked = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const next = await harness(t, {
      root,
      open: [answered, OLDER],
      baseMoved: true,
      config: { concurrency },
      onEvent: (record) => {
        if (record['kind'] === 'land.blocked') {
          blocked();
        }
      },
    });
    if (concurrency > 1) {
      // The older issue reaches the landing lock first, while the halted commit is still unchecked: #7's resume
      // waits before its landing step, outside the repo and landing locks, until #5 is blocked.
      const discardChanges = next.context.ports.discardChanges;
      next.context.ports.discardChanges = async (...args) => {
        if (args[2] === '7') {
          await landBlocked;
        }
        return discardChanges(...args);
      };
    }
    const reports = await runLoop(next, concurrency);
    const seven = reports.find((report) => report.issue === 7);
    assert.equal(seven?.outcome, 'done');
    assert.deepEqual(next.baseWaits.slice(0, 1), ['2']);
    assert.equal(await readState(next.context.repo, 7), undefined);
    const five = reports.find((report) => report.issue === 5);
    if (concurrency === 1) {
      assert.equal(five?.outcome, 'done');
      assert.equal(next.landed.length, 1);
      return;
    }
    assert.equal(five?.reason, 'base unchecked');
    assert.deepEqual(next.landed, []);
    const later = await harness(t, { root, open: [OLDER] });
    const again = await runLoop(later, concurrency);
    assert.equal(again[0]?.outcome, 'done');
    assert.equal(later.landed.length, 1);
  });
}
