import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Issue } from '../src/shared/github.mts';
import { hunter } from '../src/shared/hunt.mts';
import { runIssues } from '../src/shared/loop.mts';
import { pendingIssues } from '../src/worker/pending.mts';
import { processIssue } from '../src/worker/pipeline.mts';
import type { Ports } from '../src/shared/ports.mts';
import { upcomingIssues } from '../src/worker/upcoming.mts';
import { APPROVE, type Harness, harness, ISSUE, type Plan } from './harness.mts';

const GIVEN_UP: Issue = {
  ...ISSUE,
  number: 3,
  createdAt: '2025-12-01T00:00:00Z',
  labels: ['status:todo', 'status:blocked'],
};
const WAITING: Issue = {
  ...ISSUE,
  number: 4,
  createdAt: '2025-12-02T00:00:00Z',
  labels: ['status:todo', 'status:needs-human'],
};
const OTHER_GIVEN_UP: Issue = { ...GIVEN_UP, number: 5, createdAt: '2025-12-03T00:00:00Z' };

const HAND_OVER_NOTE = {
  author: 'bot',
  body: '### next-issue · Hand-over: needs help\n\nNo fix commit.',
};

function search(issues: Issue[]): Ports['openIssues'] {
  return async (_repo, limit, labels, without = [], every = []) =>
    issues
      .filter(
        (issue) =>
          (labels.length === 0 || labels.some((label) => issue.labels.includes(label))) &&
          every.every((label) => issue.labels.includes(label)) &&
          !without.some((label) => issue.labels.includes(label)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
}

async function limited(t: TestContext, open: Issue[], plan: Plan = {}): Promise<Harness> {
  const target = await harness(t, {
    open,
    verdicts: [APPROVE],
    config: { issueLimit: 2 },
    ...plan,
  });
  target.context.ports.openIssues = search(open);
  return target;
}

async function outcomes(target: Harness): Promise<Array<[number, string]>> {
  const { context } = target;
  const { reports } = await runIssues({
    issues: () => pendingIssues(context),
    process: (issue, claimed, slot) => processIssue(context, issue, claimed, slot),
    stop: () => false,
  });
  return reports.map((report) => [report.issue, report.outcome]);
}

test('a user whose given-up and waiting issues fill the issue limit gets a newer ready issue claimed and the given-up issue left alone', async (t) => {
  const target = await limited(t, [GIVEN_UP, WAITING, OTHER_GIVEN_UP, ISSUE]);
  assert.deepEqual(await outcomes(target), [
    [4, 'skipped'],
    [7, 'done'],
  ]);
});

test('a writer who answers a waiting issue with no state file behind a full issue limit of given-up issues gets it claimed', async (t) => {
  const answered = { ...ISSUE, labels: ['status:todo', 'status:needs-human'] };
  const target = await limited(t, [GIVEN_UP, OTHER_GIVEN_UP, answered], {
    thread: [HAND_OVER_NOTE, { author: 'owner', body: 'Ready, take it.' }],
    writers: ['owner', 'bot'],
  });
  assert.deepEqual(await outcomes(target), [[7, 'done']]);
});

test('a writer who answers a waiting ready issue with no state file behind a full issue limit of waiting issues without the ready label gets it claimed', async (t) => {
  const unready = (number: number, day: string): Issue => ({
    ...ISSUE,
    number,
    createdAt: `2025-12-0${day}T00:00:00Z`,
    labels: ['status:needs-human'],
  });
  const answered = { ...ISSUE, labels: ['status:todo', 'status:needs-human'] };
  const target = await limited(t, [unready(3, '1'), unready(5, '2'), answered], {
    thread: [HAND_OVER_NOTE, { author: 'owner', body: 'Ready, take it.' }],
    writers: ['owner', 'bot'],
  });
  assert.deepEqual(await outcomes(target), [[7, 'done']]);
});

test('a user whose given-up and waiting issues fill the issue limit sees a newer ready issue in the upcoming list', async (t) => {
  const target = await limited(t, [GIVEN_UP, WAITING, OTHER_GIVEN_UP, ISSUE]);
  const { repo, config, ports } = target.context;
  const upcoming = await upcomingIssues(repo, config, {
    openIssues: ports.openIssues,
    openBlockers: async () => [],
  });
  assert.deepEqual(upcoming.claimable, [{ issue: 7, title: ISSUE.title }]);
});

test('a user who hunts with given-up and waiting issues filling the issue limit sees the hunter count a newer ready issue', async (t) => {
  const target = await limited(t, [GIVEN_UP, WAITING, OTHER_GIVEN_UP, ISSUE]);
  target.context.ports.openBlockers = async () => [];
  const ready = await hunter(target.context).ready(new Set(), new Set());
  assert.deepEqual(
    ready.map((issue) => issue.number),
    [7],
  );
});
