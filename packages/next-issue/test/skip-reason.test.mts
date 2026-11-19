import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/shared/config.mts';
import type { Issue } from '../src/shared/github.mts';
import { skipReason } from '../src/shared/skip.mts';
import { ISSUE } from './harness.mts';

const config = await loadConfig('/does-not-exist');

function issue(labels: string[]): Issue {
  return { ...ISSUE, labels };
}

test('the worker claims a fresh issue only with the ready label', () => {
  assert.equal(skipReason(issue(['status:todo']), config, false), undefined);
  assert.equal(skipReason(issue([]), config, false), 'not-ready');
});

test('the worker skips an issue with the stop label whatever else it has', () => {
  for (const label of ['status:done', 'status:needs-human', 'status:blocked']) {
    assert.equal(skipReason(issue(['status:todo', label]), config, false), 'stop-label');
    assert.equal(skipReason(issue([label]), config, true), 'stop-label');
  }
});

test('the worker leaves alone an issue whose work is already in flight', () => {
  assert.equal(
    skipReason(issue(['status:todo', 'status:in-progress']), config, false),
    'in-flight',
  );
  assert.equal(skipReason(issue(['status:todo', 'status:in-review']), config, false), 'in-flight');
});

test('the worker resumes a saved issue whatever its ready and flight labels', () => {
  assert.equal(skipReason(issue(['status:in-progress']), config, true), undefined);
  assert.equal(skipReason(issue(['status:in-review']), config, true), undefined);
  assert.equal(skipReason(issue([]), config, true), undefined);
});

test('the worker claims an issue without the ready label when the ready label is empty', async () => {
  const open = { ...config, labels: { ...config.labels, ready: '' } };
  assert.equal(skipReason(issue([]), open, false), undefined);
  assert.equal(skipReason(issue(['status:in-review']), open, false), 'in-flight');
});
