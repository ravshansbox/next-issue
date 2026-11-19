import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSummary, type RunSummary } from '../src/shared/summary.mts';
import { emptyUsage, type RoleTotals } from '../src/shared/usage.mts';

function role(total: number, calls: number): RoleTotals {
  return { ...emptyUsage(), total, calls, ms: 0 };
}

const SUMMARY: RunSummary = {
  runId: '2026-08-24T10-00-00-000Z',
  logFile: '.next-issue/runs/2026-08-24T10-00-00-000Z.jsonl',
  roles: { implementer: role(38_100, 1), reviewer: role(21_500, 3) },
  counts: { 'issue.start': 2 },
  total: { ...emptyUsage(), total: 59_600 },
  issues: [
    { issue: 41, outcome: 'done', ciFixes: 0, reviewRounds: 2, ms: 72_000 },
    {
      issue: 43,
      outcome: 'needs-human',
      reason: 'review budget',
      ciFixes: 1,
      reviewRounds: 3,
      ms: 245_000,
    },
    { issue: 44, outcome: 'skipped', ciFixes: 0, reviewRounds: 0, ms: 0 },
  ],
};

test('the run summary counts every outcome', () => {
  const lines = formatSummary(SUMMARY).split('\n');
  assert.equal(lines[0], 'run 2026-08-24T10-00-00-000Z');
  assert.equal(lines[1], 'issues 3: 1 done, 1 needs-human, 0 error, 1 skipped, 0 stopped');
});

test('the run summary drops the empty fields of an issue', () => {
  const lines = formatSummary(SUMMARY).split('\n');
  assert.match(lines[2]!, /#41 done\b.*reviews 2 .*1m12s$/);
  assert.doesNotMatch(lines[2]!, /ci fixes/);
  assert.match(lines[3]!, /#43 needs-human\b.*ci fixes 1 .*reviews 3 .*4m .*\(review budget\)$/);
  assert.equal(lines[4], '  #44 skipped');
});

test('a user sees seconds in an issue time of the summary only under 2 minutes, then whole minutes, then hours', () => {
  const spent = (ms: number): string => {
    const issue = { issue: 41, outcome: 'done' as const, ciFixes: 0, reviewRounds: 0, ms };
    return formatSummary({ ...SUMMARY, issues: [issue] })
      .split('\n')[2]!
      .split(' ')
      .at(-1)!;
  };
  assert.equal(spent(40_400), '40s');
  assert.equal(spent(59_400), '59s');
  assert.equal(spent(59_600), '1m00s');
  assert.equal(spent(72_000), '1m12s');
  assert.equal(spent(119_400), '1m59s');
  assert.equal(spent(119_600), '2m');
  assert.equal(spent(245_000), '4m');
  assert.equal(spent(290_000), '5m');
  assert.equal(spent(3_570_000), '1h');
  assert.equal(spent(4_500_000), '1h15m');
  assert.equal(spent(7_200_000), '2h');
  assert.equal(spent(32_400_000), '9h');
});

test('the run summary shortens the token totals', () => {
  const lines = formatSummary(SUMMARY).split('\n');
  assert.equal(lines[5], 'tokens 59.6k (implementer 38.1k in 1, reviewer 21.5k in 3)');
  assert.equal(lines[6], `log ${SUMMARY.logFile}`);
});

test('the run summary shows a run without issues', () => {
  const empty = formatSummary({ ...SUMMARY, roles: {}, issues: [], total: emptyUsage() });
  assert.equal(
    empty.split('\n')[1],
    'issues 0: 0 done, 0 needs-human, 0 error, 0 skipped, 0 stopped',
  );
  assert.match(empty, /\ntokens 0\n/);
});
