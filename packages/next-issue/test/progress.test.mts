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
