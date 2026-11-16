import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mts';
import { harness, ISSUE } from './harness.mts';

const config = await loadConfig('/does-not-exist');

type Target = Awaited<ReturnType<typeof harness>>;

function labelsAfter(target: Target, labels: string[]): string[] {
  return target.labels.reduce(
    (current, { label }, index) => [
      ...current.filter((name) => name === label || !target.removable[index]!.includes(name)),
      ...(current.includes(label) ? [] : [label]),
    ],
    labels,
  );
}

async function handedOver(t: Parameters<typeof harness>[0]) {
  const first = await harness(t, { commits: [false] });
  const report = await first.run();
  assert.equal(report.outcome, 'needs-human');
  return { first, labels: labelsAfter(first, ISSUE.labels) };
}

test('a user whose issue is handed over sees the needs-human label added and the ready label kept', async (t) => {
  const { labels } = await handedOver(t);
  assert.deepEqual(labels.toSorted(), ['status:needs-human', 'status:todo']);
});

test('a user whose issue is handed over with an empty ready label sees only the needs-human label', async (t) => {
  const target = await harness(t, {
    commits: [false],
    config: { labels: { ...config.labels, ready: '' } },
  });
  await target.run();
  assert.deepEqual(labelsAfter(target, ['status:in-review']), ['status:needs-human']);
});

test('a person who takes the needs-human label off a handed-over issue with no state file gets it claimed by the next run', async (t) => {
  const { labels } = await handedOver(t);
  const next = await harness(t, {
    issue: { ...ISSUE, labels: labels.filter((name) => name !== 'status:needs-human') },
  });
  const report = await next.run();
  assert.equal(report.outcome, 'done');
});

test('a writer who answers a handed-over issue with no state file gets it claimed by the next run and the needs-human label taken off', async (t) => {
  const { first, labels } = await handedOver(t);
  const next = await harness(t, {
    issue: { ...ISSUE, labels },
    thread: [
      { author: 'bot', body: first.issueNotes[0]!.body },
      { author: 'owner', body: 'Ready, take it.' },
    ],
    writers: ['owner', 'bot'],
  });
  const report = await next.run();
  assert.equal(report.outcome, 'done');
  assert.ok(!labelsAfter(next, labels).includes('status:needs-human'));
});

test('a run that finds a handed-over issue with the ready label and no answer skips it', async (t) => {
  const { labels } = await handedOver(t);
  const next = await harness(t, { issue: { ...ISSUE, labels } });
  const report = await next.run();
  assert.equal(report.outcome, 'skipped');
});
