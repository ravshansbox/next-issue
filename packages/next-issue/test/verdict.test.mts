import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockingFindings,
  formatVerdict,
  openFindings,
  parseVerdict,
  readVerdict,
  type Verdict,
} from '../src/worker/verdict.mts';

const BLOCKING: Verdict = {
  summary: 'One problem is left.',
  findings: [
    { severity: 'blocking', detail: 'The count is wrong.' },
    { severity: 'minor', detail: 'The name is long.' },
  ],
};

test('the worker reads the last json block of the reviewer text as the verdict', () => {
  const text = [
    'The rule says to end like this:',
    '```json\n{"summary": "example", "findings": []}\n```',
    'Here is my verdict.',
    '```json',
    JSON.stringify(BLOCKING, null, 2),
    '```',
  ].join('\n');
  assert.deepEqual(parseVerdict(text), BLOCKING);
});

test('the worker reads a verdict whose strings hold three backticks', () => {
  const verdict: Verdict = {
    summary: 'Quote ```x``` here.',
    findings: [{ severity: 'blocking', detail: 'Add a test:\n```ts\nassert(x)\n```' }],
  };
  const text = [
    '```json\n{"summary": "example", "findings": []}\n```',
    '```json',
    JSON.stringify(verdict, null, 2),
    '```',
    'Done.',
  ].join('\n');
  assert.deepEqual(parseVerdict(text), verdict);
  assert.deepEqual(parseVerdict(`\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``), verdict);
});

test('the worker reads a verdict whose strings quote a fenced json block', () => {
  const verdict: Verdict = {
    summary: 'Quote ```json\n{}\n``` here.',
    findings: [{ severity: 'blocking', detail: 'Add to config:\n```json\n{"a": 1}\n```' }],
  };
  const text = ['```json', JSON.stringify(verdict, null, 2), '```', 'Done.'].join('\n');
  assert.deepEqual(parseVerdict(text), verdict);
  assert.deepEqual(parseVerdict(`\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``), verdict);
});

test('the worker finds no verdict when the last json block is invalid after a valid one', () => {
  const valid = JSON.stringify({ summary: 'ok', findings: [] });
  assert.equal(
    parseVerdict(`\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n{"summary": \n\`\`\``),
    undefined,
  );
  assert.equal(
    parseVerdict(`\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n{"a": 1}\n\`\`\``),
    undefined,
  );
});

test('the worker finds no verdict without a valid json block', () => {
  assert.equal(parseVerdict('Looks good to me.'), undefined);
  assert.equal(parseVerdict('```json\n{"summary": \n```'), undefined);
  assert.equal(parseVerdict('```json\n{"summary": "x"}\n```'), undefined);
});

test('the worker refuses a verdict value of the wrong shape', () => {
  assert.equal(readVerdict(undefined), undefined);
  assert.equal(readVerdict('approve'), undefined);
  assert.equal(readVerdict({ summary: 'x' }), undefined);
  assert.equal(readVerdict({ findings: [] }), undefined);
  assert.equal(readVerdict({ summary: 1, findings: [] }), undefined);
  assert.deepEqual(readVerdict(BLOCKING), BLOCKING);
});

test('the worker refuses a verdict with a finding that is not complete', () => {
  const bad = (findings: unknown[]): unknown => ({ summary: 'x', findings });
  assert.equal(readVerdict(bad([{ detail: 'no severity' }])), undefined);
  assert.equal(readVerdict(bad([{ severity: 'bad', detail: 'wrong severity' }])), undefined);
  assert.equal(readVerdict(bad([{ severity: 'blocking' }])), undefined);
  assert.equal(readVerdict(bad(['text'])), undefined);
  assert.equal(readVerdict(bad([null])), undefined);
});

test('the worker drops the verdict fields that it does not know', () => {
  assert.deepEqual(
    readVerdict({
      verdict: 'approve',
      summary: 'Good.',
      findings: [{ severity: 'minor', detail: 'long name', file: 'a.ts' }],
      score: 9,
    }),
    { summary: 'Good.', findings: [{ severity: 'minor', detail: 'long name' }] },
  );
});

test('the worker keeps every finding open while a review round is left', () => {
  assert.equal(blockingFindings(BLOCKING).length, 1);
  assert.deepEqual(openFindings(BLOCKING, false), BLOCKING.findings);
  const taste: Verdict = {
    summary: '',
    findings: [{ severity: 'minor', detail: 'taste' }],
  };
  assert.equal(openFindings(taste, false).length, 1);
});

test('the worker no longer keeps a minor finding open in the last round', () => {
  assert.deepEqual(openFindings(BLOCKING, true), [
    { severity: 'blocking', detail: 'The count is wrong.' },
  ]);
  const taste: Verdict = {
    summary: '',
    findings: [{ severity: 'minor', detail: 'taste' }],
  };
  assert.deepEqual(openFindings(taste, true), []);
  assert.deepEqual(openFindings({ summary: '', findings: [] }, true), []);
});

test('the worker ignores an approve or reject field that the reviewer adds', () => {
  assert.deepEqual(readVerdict({ verdict: 'approve', summary: 'Good enough.', findings: [] }), {
    summary: 'Good enough.',
    findings: [],
  });
  const contradictory = readVerdict({
    verdict: 'approve',
    summary: 'Good enough.',
    findings: [{ severity: 'blocking', detail: 'The migration drops the table.' }],
  })!;
  const open = openFindings(contradictory, true);
  assert.equal(open.length, 1);
  assert.match(formatVerdict(contradictory, open), /### next-issue · Review: changes requested/);
});

test('the worker shows the head, the summary and every finding of a verdict', () => {
  const text = formatVerdict(BLOCKING, BLOCKING.findings);
  assert.match(text, /### next-issue · Review: changes requested/);
  assert.match(text, /One problem is left\./);
  assert.match(text, /- \*\*blocking\*\* The count is wrong\./);
  assert.match(text, /- \*\*minor\*\* The name is long\./);
  assert.match(formatVerdict({ summary: 'Good.', findings: [] }, []), /Review: approved/);
});

test('the worker says why an approval leaves a finding', () => {
  const taste: Verdict = {
    summary: 'Taste only.',
    findings: [{ severity: 'minor', detail: 'The name is long.' }],
  };
  const text = formatVerdict(taste, []);
  assert.match(text, /### next-issue · Review: approved/);
  assert.match(text, /- \*\*minor\*\* The name is long\./);
  assert.match(text, /the review budget is spent/);
  assert.doesNotMatch(formatVerdict(taste, taste.findings), /the review budget is spent/);
});
