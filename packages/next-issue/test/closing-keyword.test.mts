import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mts';

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#\d/i;

test('an implementer whose subject closes the issue lands a commit that closes no issue', async (t) => {
  const target = await harness(t, { implementerText: ['commit: fix: x (closes #7)'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.ok(target.messages.length > 0);
  for (const message of target.messages) {
    assert.doesNotMatch(message, CLOSING);
  }
  assert.match(target.messages.at(-1)!, /^fix: x\n/);
});
