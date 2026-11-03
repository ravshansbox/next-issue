import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, startProgress } from '../src/progress.mts';
import type { Progress } from '../src/protocol.mts';
import type { Fields } from '../src/observe.mts';

function replay(records: Fields[]): Progress {
  return records.reduce(applyEvent, startProgress());
}

test('a watcher sees the issue, its title and when it started once an issue starts', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 12, title: 'Fix it', ts: '2026-11-02T10:00:00.000Z' },
  ]);
  assert.equal(progress.issue, 12);
  assert.equal(progress.title, 'Fix it');
  assert.equal(progress.issueStartedAt, Date.parse('2026-11-02T10:00:00.000Z'));
  assert.equal(progress.tools, 0);
});

test('a watcher sees the step of the issue, with the round when the step has one', () => {
  const start = { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' };
  assert.equal(replay([start, { kind: 'implement.start' }]).stage, 'implement');
  assert.equal(replay([start, { kind: 'review.start', round: 2 }]).stage, 'review 2');
  assert.equal(replay([start, { kind: 'agent.start' }]).stage, undefined);
});

test('a watcher sees the tool count and the last tool with the first line of its command', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'tool', tool: 'read' },
    { kind: 'tool', tool: 'bash', command: 'npm test\necho done' },
  ]);
  assert.equal(progress.tools, 2);
  assert.equal(progress.lastTool, 'bash npm test');
});

test('a watcher sees a long tool line cut to 80 characters', () => {
  const progress = replay([{ kind: 'tool', tool: 'bash', command: 'x'.repeat(200) }]);
  assert.equal(progress.lastTool?.length, 80);
  assert.equal(progress.lastTool?.endsWith('…'), true);
});

test('a watcher sees each handled issue, and no skipped one, once the issue ends', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 1, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 1, outcome: 'done' },
    { kind: 'issue.end', issue: 2, outcome: 'skipped' },
    { kind: 'issue.start', issue: 3, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 3, outcome: 'needs-human' },
    { kind: 'issue.start', issue: 4, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.error', issue: 4, error: 'boom' },
  ]);
  assert.deepEqual(progress.handled, [
    { issue: 1, outcome: 'done' },
    { issue: 3, outcome: 'needs-human' },
    { issue: 4, outcome: 'error' },
  ]);
  assert.equal(progress.issue, undefined);
  assert.equal(progress.stage, undefined);
});

test('a watcher sees the error when the issues cannot be read', () => {
  assert.equal(replay([{ kind: 'issues.fail', error: 'gh failed' }]).error, 'gh failed');
});
