import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, startProgress } from '../src/worker/progress.mts';

test('a watcher sees whether the run hunts, and events keep that field', () => {
  assert.equal(startProgress(true).hunting, true);
  assert.equal(startProgress(false).hunting, false);
  const progress = [
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 12, outcome: 'done' },
  ].reduce(applyEvent, startProgress(true));
  assert.equal(progress.hunting, true);
});

test('a watcher sees each running issue with its current step, and the issue leaves once it ends', () => {
  const seen: unknown[] = [];
  [
    { kind: 'issue.start', issue: 12 },
    { kind: 'issue.start', issue: 13 },
    { kind: 'implement.start', issue: 12 },
    { kind: 'review.start', issue: 12, round: 1, limit: 3 },
    { kind: 'fix.start', issue: 12 },
    { kind: 'check.start', issue: 12 },
    { kind: 'land.start', issue: 12 },
    { kind: 'ci-checks.start', issue: 12 },
    { kind: 'issue.end', issue: 12, outcome: 'done' },
    { kind: 'commit-fix.start', issue: 13 },
    { kind: 'issue.error', issue: 13, error: 'boom' },
  ].reduce((progress, record) => {
    const next = applyEvent(progress, record);
    seen.push(next.issues);
    return next;
  }, startProgress());
  assert.deepEqual(seen, [
    [{ issue: 12 }],
    [{ issue: 12 }, { issue: 13 }],
    [{ issue: 12, step: 'implementing' }, { issue: 13 }],
    [{ issue: 12, step: 'reviewing', round: 1 }, { issue: 13 }],
    [{ issue: 12, step: 'fixing' }, { issue: 13 }],
    [{ issue: 12, step: 'fixing' }, { issue: 13 }],
    [{ issue: 12, step: 'landing' }, { issue: 13 }],
    [{ issue: 12, step: 'waiting-for-checks' }, { issue: 13 }],
    [{ issue: 13 }],
    [{ issue: 13, step: 'fixing' }],
    [],
  ]);
});

test('a watcher sees an empty issue list for a run with no running issue, and no step of the hunter', () => {
  assert.deepEqual(startProgress().issues, []);
  const progress = [{ kind: 'hunt.start' }, { kind: 'ci-checks.start', issue: 40 }].reduce(
    applyEvent,
    startProgress(),
  );
  assert.deepEqual(progress.issues, []);
});

test('a watcher sees hunt true while a hunt runs, and no hunt field before it starts or after it ends', () => {
  const before = startProgress(true);
  const during = applyEvent(before, { kind: 'hunt.start' });
  const after = applyEvent(during, { kind: 'hunt.end', ms: 5 });
  assert.equal('hunt' in before, false);
  assert.equal(during.hunt, true);
  assert.equal('hunt' in after, false);
});
