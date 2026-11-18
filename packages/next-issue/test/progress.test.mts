import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fields } from '../src/shared/observe.mts';
import { applyEvent, startProgress } from '../src/worker/progress.mts';
import type { Progress } from '../src/shared/protocol.mts';

function replay(records: Fields[]): Progress {
  return records.reduce(applyEvent, startProgress());
}

test('a watcher sees the error when the issues cannot be read', () => {
  assert.equal(replay([{ kind: 'issues.fail', error: 'gh failed' }]).error, 'gh failed');
});

test('a watcher sees whether the run hunts, and events keep that field', () => {
  assert.equal(startProgress(true).hunting, true);
  assert.equal(startProgress(false).hunting, false);
  const progress = [
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 12, outcome: 'done' },
  ].reduce(applyEvent, startProgress(true));
  assert.equal(progress.hunting, true);
});
