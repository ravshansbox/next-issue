import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PORTS } from '../src/shared/ports.mts';
import { harness, ISSUE, roles } from './harness.mts';
import { tempDir } from './temp-dir.mts';

const CHECKS = ['npm run lint', 'npm test'];

test('a user whose checks pass gets each command run in order on the merged change before it is pushed', async (t) => {
  const target = await harness(t, { config: { checks: CHECKS } });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.checks, [
    { command: 'npm run lint', head: '2' },
    { command: 'npm test', head: '2' },
  ]);
  assert.deepEqual(target.landed, ['2']);
  assert.equal(report.ciFixes, 0);
  assert.equal(target.events.filter((record) => record.kind === 'check.end').length, 2);
});

test('a user with no checks set gets the change pushed with no command run', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(target.checks, []);
  assert.deepEqual(target.landed, ['2']);
});

test('a user whose check fails gets the fixer with the command and its output, and the fixed change merged, checked again and pushed as one commit', async (t) => {
  const target = await harness(t, {
    config: { checks: CHECKS },
    checkCodes: [0, 1],
    implementerText: ['Done.\ncommit: feat: add the flag'],
    fixerText: 'commit: fix: make the test pass',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  const fix = target.prompts.at(-1)!.prompt;
  assert.match(fix, /`npm test` failed/);
  assert.match(fix, /npm test broke/);
  assert.deepEqual(
    target.checks.map((entry) => `${entry.command}@${entry.head}`),
    ['npm run lint@2', 'npm test@2', 'npm run lint@4', 'npm test@4'],
  );
  assert.equal(target.baseMerges, 2);
  assert.deepEqual(target.landed, ['4']);
  assert.equal(report.ciFixes, 1);
  assert.match(target.messages.at(-1)!, /^feat: add the flag\n\nRefs #7$/);
  assert.deepEqual(target.closed, [7]);
});

test('a user whose check keeps failing gets the issue handed over with the command named once the budget runs out, and nothing pushed', async (t) => {
  const target = await harness(t, {
    config: { checks: CHECKS, maxCiFixes: 1 },
    checkCodes: [0, 1, 0, 1],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'local checks failed: npm test');
  assert.deepEqual(target.landed, []);
  assert.deepEqual(target.reverts, []);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  assert.match(target.comments.at(-1)!, /`npm test` failed/);
  assert.match(target.comments.at(-1)!, /npm test broke/);
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
});

test('a user whose check does not finish in time gets the issue handed over with the timeout named once the budget runs out, and nothing pushed', async (t) => {
  const target = await harness(t, {
    config: { checks: ['npm test'], maxCiFixes: 0, checksTimeoutMinutes: 7 },
    checkCodes: ['timeout'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'local checks failed: npm test');
  assert.deepEqual(target.landed, []);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.match(target.comments.at(-1)!, /`npm test` did not finish in 7 minutes/);
  assert.match(target.comments.at(-1)!, /npm test hung/);
});

test('a user whose fixer calls the failed check unrelated gets the issue handed over and nothing pushed', async (t) => {
  const target = await harness(t, {
    config: { checks: ['npm test'] },
    checkCodes: [1],
    fixerText: 'unrelated: the test is broken on main',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'unrelated failure');
  assert.deepEqual(target.landed, []);
  assert.match(target.comments.at(-1)!, /`npm test`/);
});

test('a user who stops the run while a check runs gets nothing pushed, and the next run checks again before the push', async (t) => {
  const first = await harness(t, { config: { checks: ['npm test'] }, stopNowDuringCheck: true });
  const report = await first.run();
  assert.equal(report.outcome, 'stopped');
  assert.deepEqual(first.landed, []);
  const saved = (await first.state())!;
  assert.equal(saved.phase, 'approved');
  assert.equal(saved.ciFixes, 0);
  const next = await harness(t, {
    root: first.context.repo.root,
    issue: { ...ISSUE, labels: ['status:in-review'] },
    config: { checks: ['npm test'] },
  });
  assert.equal((await next.run()).outcome, 'done');
  assert.deepEqual(roles(next), []);
  assert.equal(next.checks.length, 1);
  assert.deepEqual(next.landed, [next.checks[0]!.head]);
});

test('a user whose check command writes to stdout and stderr gets both in its output with the exit code', async () => {
  const result = await PORTS.runCheck('echo out; echo err >&2; exit 3', await tempDir(), 10_000);
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /out\nerr/);
});

test('a user whose check command runs past its timeout gets it killed and reported as timed out', async () => {
  const started = Date.now();
  const result = await PORTS.runCheck('echo started; sleep 60', await tempDir(), 3_000);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 30_000);
  assert.match(result.output, /started/);
});
