import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { IssueReport } from '../src/job.mts';
import { runIssues } from '../src/loop.mts';
import { pendingIssues } from '../src/pending.mts';
import { processIssue } from '../src/pipeline.mts';
import { APPROVE, type Harness, harness, ISSUE, type Plan } from './harness.mts';

const WAIT_MS = 1000;

const A = ISSUE;
const B = { ...ISSUE, number: 8, createdAt: '2026-01-02T00:00:00Z' };
const C = { ...ISSUE, number: 9, createdAt: '2026-01-03T00:00:00Z' };

type Watched = Harness & {
  order: string[];
  most: number;
  started: (role: string, issue: number) => Promise<void>;
};

async function watched(t: Parameters<typeof harness>[0], plan: Plan): Promise<Watched> {
  const target = (await harness(t, plan)) as Watched;
  const { ports } = target.context;
  target.order = [];
  target.most = 0;
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  target.started = (role, issue) =>
    target.order.includes(`${role} #${issue}`)
      ? Promise.resolve()
      : Promise.race([
          new Promise<void>((resolve) => waiters.push({ name: `${role} #${issue}`, resolve })),
          delay(WAIT_MS),
        ]);
  let running = 0;
  const runAgent = ports.runAgent;
  ports.runAgent = async (recorder, request) => {
    const issue = /# Issue #(\d+)/.exec(request.prompt)?.[1];
    const name = `${request.name} #${issue}`;
    running += 1;
    target.most = Math.max(target.most, running);
    target.order.push(name);
    for (const waiter of waiters.filter((entry) => entry.name === name)) {
      waiter.resolve();
    }
    try {
      await delay(10);
      return await runAgent(recorder, request);
    } finally {
      running -= 1;
    }
  };
  return target;
}

function holdChecks(target: Watched, until: () => Promise<void>): void {
  const { ports } = target.context;
  const waitForCiChecks = ports.waitForCiChecks;
  let waits = 0;
  ports.waitForCiChecks = async (...args) => {
    waits += 1;
    const wait = waits;
    target.order.push(`checks ${wait}`);
    if (wait === 1) {
      await until();
    }
    const checks = await waitForCiChecks(...args);
    target.order.push(`checks end ${wait}`);
    return checks;
  };
}

function assertBefore(order: string[], first: string, then: string): void {
  assert.ok(
    order.includes(first) && order.includes(then),
    `${first} and ${then} in ${order.join(', ')}`,
  );
  assert.ok(
    order.indexOf(first) < order.indexOf(then),
    `${first} before ${then} in ${order.join(', ')}`,
  );
}

async function runLoop(target: Harness): Promise<IssueReport[]> {
  const { context } = target;
  const { reports } = await runIssues({
    issues: () => pendingIssues(context),
    process: (issue, claimed, slot) => processIssue(context, issue, claimed, slot),
    stop: () => false,
    concurrency: context.config.concurrency,
  });
  return reports;
}

test('a user with concurrency 1 whose approved issue waits for its checks gets the next issue claimed and its implementer run meanwhile', async (t) => {
  const target = await watched(t, { open: [A, B], verdicts: [APPROVE, APPROVE] });
  holdChecks(target, () => target.started('implementer', 8));
  const reports = await runLoop(target);
  assert.deepEqual(
    reports.map((report) => [report.issue, report.outcome]),
    [
      [7, 'done'],
      [8, 'done'],
    ],
  );
  assertBefore(target.order, 'implementer #8', 'checks end 1');
});

test('a user with concurrency 1 whose second issue is approved while the checks of the first run gets that issue waiting to land and a third issue claimed', async (t) => {
  const target = await watched(t, {
    open: [A, B, C],
    verdicts: [APPROVE, APPROVE, APPROVE],
  });
  holdChecks(target, () => target.started('implementer', 9));
  const reports = await runLoop(target);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done', 'done'],
  );
  assertBefore(target.order, 'reviewer #8', 'implementer #9');
  assertBefore(target.order, 'implementer #9', 'checks end 1');
  assert.equal(target.landed.length, 3);
});

test('a user with concurrency 1 whose landed issue needs the fixer after failed checks gets the fixer run before a new issue is claimed and never two agents at once', async (t) => {
  const target = await watched(t, {
    open: [A, B, C],
    verdicts: [APPROVE, APPROVE, APPROVE],
    baseChecks: ['fail'],
  });
  holdChecks(target, () => target.started('implementer', 8));
  const reports = await runLoop(target);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done', 'done', 'done'],
  );
  assertBefore(target.order, 'implementer #8', 'fixer #7');
  assertBefore(target.order, 'fixer #7', 'implementer #9');
  assert.equal(target.most, 1);
});

test('a user with concurrency 1 whose landed issue halts the run gets the issue waiting to land stopped with run halted', async (t) => {
  const target = await watched(t, {
    open: [A, B],
    verdicts: [APPROVE, APPROVE],
    config: { maxCiFixes: 0, maxReviewRounds: 1 },
    baseChecks: ['fail'],
    revertFails: true,
  });
  holdChecks(target, () => target.started('reviewer', 8));
  const reports = await runLoop(target);
  const seven = reports.find((report) => report.issue === 7);
  const eight = reports.find((report) => report.issue === 8);
  assert.equal(seven?.halt, true);
  assert.equal(eight?.outcome, 'stopped');
  assert.equal(eight?.reason, 'run halted');
  assert.deepEqual(target.landed, ['2']);
});

test('a user with concurrency 1 whose second issue is blocked by the first gets the second issue claimed and done once the first is closed', async (t) => {
  const target = await watched(t, { open: [A, B], verdicts: [APPROVE, APPROVE] });
  const { ports } = target.context;
  ports.openBlockers = async (_repo, number) =>
    number === 8 && !target.closed.includes(7) ? ['#7'] : [];
  const reports = await runLoop(target);
  assert.deepEqual(
    reports
      .filter((report) => report.outcome !== 'skipped')
      .map((report) => [report.issue, report.outcome]),
    [
      [7, 'done'],
      [8, 'done'],
    ],
  );
});

test('a user with concurrency 1 whose only issue needs the fixer after failed checks gets the open issues listed only at the start and once the issue ends', async (t) => {
  const target = await watched(t, { open: [A], verdicts: [APPROVE], baseChecks: ['fail'] });
  const { ports } = target.context;
  const openIssues = ports.openIssues;
  let lists = 0;
  ports.openIssues = async (...args) => {
    lists += 1;
    return openIssues(...args);
  };
  const reports = await runLoop(target);
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ['done'],
  );
  assert.ok(target.order.includes('fixer #7'), target.order.join(', '));
  assert.equal(lists, 2);
});
