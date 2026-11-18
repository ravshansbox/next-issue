import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fields } from '../src/shared/observe.mts';
import { applyEvent, startProgress } from '../src/worker/progress.mts';
import type { Progress } from '../src/shared/protocol.mts';

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

test('a watcher sees each limited round with its count and its limit', () => {
  const start = { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' };
  const stage = (record: Fields) => replay([start, { issue: 12, ...record }]).issues[0]?.stage;
  assert.equal(stage({ kind: 'review.start', round: 2, limit: 5 }), 'review 2/5');
  assert.equal(stage({ kind: 'fix.start', cause: 'review', round: 2, limit: 5 }), 'review fix 2/5');
  assert.equal(stage({ kind: 'fix.start', cause: 'checks', round: 1, limit: 5 }), 'checks fix 1/5');
  assert.equal(stage({ kind: 'commit-fix.start', round: 3, limit: 10 }), 'commit fix 3/10');
});

test('a watcher sees the open-issue count of the latest fetch', () => {
  assert.equal(replay([{ kind: 'issues', open: 7 }]).open, 7);
  assert.equal(
    replay([
      { kind: 'issues', open: 7 },
      { kind: 'issues', open: 6 },
    ]).open,
    6,
  );
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

test('a watcher sees the last tool with its path', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 12, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'tool', issue: 12, tool: 'read', path: 'src/a.mts' },
  ]);
  assert.equal(progress.issues[0]?.lastTool, 'read src/a.mts');
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

test('a watcher sees each hand-over of an issue handed over in two passes', () => {
  const progress = replay([
    { kind: 'issue.start', issue: 4, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 4, outcome: 'needs-human' },
    { kind: 'issue.start', issue: 5, ts: '2026-11-02T10:00:00.000Z' },
    { kind: 'issue.end', issue: 5, outcome: 'done' },
    { kind: 'issue.start', issue: 4, ts: '2026-11-02T10:05:00.000Z' },
    { kind: 'issue.end', issue: 4, outcome: 'needs-human' },
  ]);
  assert.deepEqual(progress.handled, [
    { issue: 4, outcome: 'needs-human' },
    { issue: 5, outcome: 'done' },
    { issue: 4, outcome: 'needs-human' },
  ]);
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
