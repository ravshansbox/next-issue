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
  assert.deepEqual(progress.issues, [
    { issue: 12, title: 'Fix it', tools: 0, startedAt: Date.parse('2026-11-02T10:00:00.000Z') },
  ]);
});

test('a watcher sees the step of the issue, with the round when the step has one', () => {
  const start = { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' };
  const stage = (record: Fields) => replay([start, { issue: 12, ...record }]).issues[0]?.stage;
  assert.equal(stage({ kind: 'implement.start' }), 'implement');
  assert.equal(stage({ kind: 'review.start', round: 2 }), 'review 2');
  assert.equal(stage({ kind: 'agent.start' }), undefined);
});

test('a watcher sees the tool count and the last tool with the first line of its command', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'tool', issue: 12, tool: 'read' },
    { kind: 'tool', issue: 12, tool: 'bash', command: 'npm test\necho done' },
  ]);
  assert.equal(progress.issues[0]?.tools, 2);
  assert.equal(progress.issues[0]?.lastTool, 'bash npm test');
});

test('a watcher sees a long tool line cut to 80 characters', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'tool', issue: 12, tool: 'bash', command: 'x'.repeat(200) },
  ]);
  assert.equal(progress.issues[0]?.lastTool?.length, 80);
  assert.equal(progress.issues[0]?.lastTool?.endsWith('…'), true);
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
  assert.deepEqual(progress.issues, []);
});

test('a watcher sees the step and the tools of each running issue apart', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 1, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.start', issue: 2, ts: '2026-11-02T10:01:00.000Z' },
    { kind: 'implement.start', issue: 1 },
    { kind: 'tool', issue: 2, tool: 'read' },
    { kind: 'review.start', issue: 2, round: 1 },
  ]);
  assert.deepEqual(
    progress.issues.map((entry) => [entry.issue, entry.stage, entry.tools]),
    [
      [1, 'implement', 0],
      [2, 'review 1', 1],
    ],
  );
  const later = applyEvent(progress, { kind: 'issue.end', issue: 1, outcome: 'done' });
  assert.deepEqual(
    later.issues.map((entry) => entry.issue),
    [2],
  );
});

test('a watcher sees the error when the issues cannot be read', () => {
  assert.equal(replay([{ kind: 'issues.fail', error: 'gh failed' }]).error, 'gh failed');
});
