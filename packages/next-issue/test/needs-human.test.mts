import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes, harness, ISSUE, SAVED } from './harness.mts';

test('a fixer that changes nothing and says nothing hands the issue to a person', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('The count is wrong.')],
    commits: [true, false],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'no fix commit');
});

test('an implementer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { commits: [false] });
  const report = await target.run();
  assert.equal(report.reason, 'no implementation commit');
  assert.equal(target.pushes, 0);
});

test('a user whose issue is handed over because the implementer made no change sees the reply of the implementer after the note', async (t) => {
  const reply = 'I need answers first.\n\n1. Use A or B? I recommend A.';
  const target = await harness(t, { commits: [false], implementerText: [reply] });
  await target.run();
  assert.equal(
    target.issueNotes[0]!.body,
    `next-issue needs help: The implementer produced no change.\n\n${reply}`,
  );
});

test('a user whose implementer gave a reply too long for a GitHub comment sees it cut to fit with a line that says so', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['x'.repeat(70000)] });
  await target.run();
  const body = target.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.match(body, /^next-issue needs help: The implementer produced no change\.\n\nxxx/);
  assert.match(body, /\n\nThe reason was too long for a GitHub comment and was cut\.$/);
});

test('a user whose implementer gave a long reply of emoji sees it cut between whole characters', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['😀'.repeat(40000)] });
  await target.run();
  const body = target.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.doesNotMatch(body, /\p{Cs}/u);
});

test('a writer who answers a hand-over after a run error with stderr longer than a GitHub comment sees the reason cut to fit and gets the issue claimed again', async (t) => {
  const failed = await harness(t, {
    commits: [new Error(`git hook run pre-commit failed with code 1: ${'e'.repeat(200000)}`)],
  });
  const report = await failed.run();
  assert.equal(report.outcome, 'error');
  const body = failed.issueNotes[0]!.body;
  assert.ok(body.length <= 65536);
  assert.match(body, /^next-issue needs help: The run failed: git hook run pre-commit failed/);
  assert.match(body, /\n\nThe reason was too long for a GitHub comment and was cut\.$/);
  const answered = await harness(t, {
    issue: { ...ISSUE, labels: ['status:needs-human'] },
    saved: await failed.state(),
    thread: [
      { author: 'bot', body },
      { author: 'owner', body: 'Fixed the hook, take it.' },
    ],
    writers: ['owner', 'bot'],
  });
  const resumed = await answered.run();
  assert.equal(resumed.outcome, 'done');
  assert.ok(answered.removable[0]!.includes('status:needs-human'));
});

test('a user whose implementer made no change and gave no reply sees only the note', async (t) => {
  const target = await harness(t, { commits: [false], implementerText: ['  '] });
  await target.run();
  assert.equal(
    target.issueNotes[0]!.body,
    'next-issue needs help: The implementer produced no change.',
  );
});

test('a user who resumes a claimed issue whose branch is already ahead of the base gets the earlier commit landed with its subject when the implementer changes nothing', async (t) => {
  const target = await harness(t, {
    saved: { ...SAVED, phase: 'claimed' },
    commits: [false],
    earlier: 'fix: earlier work',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages.at(-1)!, /^fix: earlier work\n/);
});

test('a user whose issue is handed over before a pull request exists gets the reason as a comment on the issue', async (t) => {
  const target = await harness(t, { commits: [false] });
  await target.run();
  assert.equal(target.issueNotes.length, 1);
  assert.equal(target.issueNotes[0]!.number, 7);
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
});

test('a user whose resumed issue has a pull request in its state gets the hand-over as a comment on the issue', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: [] },
    saved: SAVED,
    config: { maxReviewRounds: 1 },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.deepEqual(
    target.issueNotes.map((note) => note.number),
    [7],
  );
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
});

test('a user whose issue is handed over after the review gets the verdict and the reason on the issue', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, baseChecks: ['fail'] });
  await target.run();
  assert.deepEqual(
    target.issueNotes.map((note) => note.number),
    [7, 7],
  );
  assert.match(target.issueNotes[0]!.body, /Review: approved/);
  assert.match(target.issueNotes[1]!.body, /needs help: /);
});

test('a fixer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { baseChecks: ['fail'], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.equal(target.reverts.length, 1);
});

const QUESTIONS = [
  'I am not sure of the scope.',
  'question: 1. Should the flag be global? a) yes b) no. I recommend a.',
  'question: 2) Which name? a) --fast b) --quick. I recommend b.',
  'commit: feat: add a flag',
].join('\n');

const ASKED = [
  '1. Should the flag be global? a) yes b) no. I recommend a.',
  '2. Which name? a) --fast b) --quick. I recommend b.',
].join('\n');

test('an implementer that asks questions hands the issue to a person with the questions listed in order and nothing committed', async (t) => {
  const target = await harness(t, {
    implementerText: [QUESTIONS],
    selfCommit: true,
    fresh: ISSUE,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'questions');
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal(
    target.issueNotes.at(-1)!.body,
    `next-issue needs help: The implementer has questions about the issue.\n\n${ASKED}`,
  );
  assert.deepEqual(target.messages, []);
  assert.equal(target.head(), '0');
  assert.equal(target.pushes, 0);
});

test('a user whose issue body cannot be edited still gets the implementer questions in the hand-over comment, the needs-human label and the failed edit in the run log', async (t) => {
  const target = await harness(t, {
    implementerText: [QUESTIONS],
    fresh: ISSUE,
    fail: 'editIssueBody',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'questions');
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal(
    target.issueNotes.at(-1)!.body,
    `next-issue needs help: The implementer has questions about the issue.\n\n${ASKED}`,
  );
  assert.deepEqual(
    target.events
      .filter((event) => event.kind === 'questions.body-failed')
      .map((event) => event.error),
    ['the port broke'],
  );
});

test('a user whose issue cannot be read again still gets the implementer questions in the hand-over comment, the needs-human label and the failed read in the run log', async (t) => {
  const target = await harness(t, {
    implementerText: [QUESTIONS],
    fail: 'viewIssue',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'questions');
  assert.equal(target.labels.at(-1)!.label, 'status:needs-human');
  assert.equal(
    target.issueNotes.at(-1)!.body,
    `next-issue needs help: The implementer has questions about the issue.\n\n${ASKED}`,
  );
  assert.deepEqual(target.bodies, []);
  assert.deepEqual(
    target.events
      .filter((event) => event.kind === 'questions.body-failed')
      .map((event) => event.error),
    ['the port broke'],
  );
});

test('a user whose implementer asks questions finds them under a new Open questions heading at the end of the issue body as GitHub holds it', async (t) => {
  const target = await harness(t, {
    implementerText: [QUESTIONS],
    fresh: { ...ISSUE, body: 'Please add it.\n\nEdited during the run.' },
  });
  await target.run();
  assert.deepEqual(target.bodies, [
    {
      number: ISSUE.number,
      body: `Please add it.\n\nEdited during the run.\n\n## Open questions\n\n${ASKED}`,
    },
  ]);
});

test('a user whose issue already has open questions keeps them and finds the new questions after them', async (t) => {
  const body = [
    '## Problem',
    '',
    'No flag.',
    '',
    '## Open questions',
    '',
    'Should it be on by default? Yes.',
    '',
    '## Notes',
    '',
    'Later.',
  ].join('\n');
  const target = await harness(t, { implementerText: [QUESTIONS], fresh: { ...ISSUE, body } });
  await target.run();
  assert.equal(
    target.bodies[0]!.body,
    [
      '## Problem',
      '',
      'No flag.',
      '',
      '## Open questions',
      '',
      'Should it be on by default? Yes.',
      '',
      ASKED,
      '',
      '## Notes',
      '',
      'Later.',
    ].join('\n'),
  );
});

test('a user whose issue has an empty Open questions section at the end finds the questions under it', async (t) => {
  const body = '## Problem\n\nNo flag.\n\n## Open questions\n';
  const target = await harness(t, { implementerText: [QUESTIONS], fresh: { ...ISSUE, body } });
  await target.run();
  assert.equal(target.bodies[0]!.body, `## Problem\n\nNo flag.\n\n## Open questions\n\n${ASKED}`);
});

test('a user whose issue has a subheading inside Open questions finds the new questions after the text under the subheading', async (t) => {
  const body = '## Open questions\n\n### From review\n\n1. Old?\n\n## Notes\n\nLater.';
  const target = await harness(t, { implementerText: [QUESTIONS], fresh: { ...ISSUE, body } });
  await target.run();
  assert.equal(
    target.bodies[0]!.body,
    `## Open questions\n\n### From review\n\n1. Old?\n\n${ASKED}\n\n## Notes\n\nLater.`,
  );
});

test('an implementer whose reply holds only a placeholder question line gets its change committed and no issue body edit', async (t) => {
  const target = await harness(t, {
    implementerText: ['question: none\ncommit: feat: add a flag'],
    fresh: ISSUE,
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[0]!, /^feat: add a flag\n/);
  assert.deepEqual(target.bodies, []);
});

const ANSWERED = [
  {
    author: 'bot',
    body: `next-issue needs help: The implementer has questions about the issue.\n\n${ASKED}`,
  },
  { author: 'owner', body: '1. b, 2. a' },
];

async function resumedImplementer(
  t: Parameters<typeof harness>[0],
  fail: 'editIssueBody' | undefined,
  thread = ANSWERED,
): Promise<string> {
  const target = await harness(t, {
    implementerText: [QUESTIONS],
    fresh: ISSUE,
    fail,
  });
  assert.equal((await target.run()).reason, 'questions');
  const next = await harness(t, {
    issue: { ...ISSUE, body: target.bodies[0]?.body ?? ISSUE.body, labels: [] },
    saved: (await target.state())!,
    thread,
    writers: ['owner', 'bot'],
  });
  await next.run();
  return next.prompts.find((entry) => entry.role === 'implementer')!.prompt;
}

test('a person who answers questions that reached only the hand-over comment gets the questions and the answer into the prompt of the next implementer', async (t) => {
  const prompt = await resumedImplementer(t, 'editIssueBody');
  assert.match(
    prompt,
    new RegExp(
      `## Answer of a person to the hand-over[\\s\\S]*${ASKED.replace(/[.?()-]/g, '\\$&')}[\\s\\S]*@owner: 1\\. b, 2\\. a`,
    ),
  );
});

test('a person who answers questions that reached the issue body gets the answer into the prompt of the next implementer without the questions repeated', async (t) => {
  const prompt = await resumedImplementer(t, undefined);
  assert.match(prompt, /@owner: 1\. b, 2\. a/);
  assert.equal(prompt.split('Which name?').length, 2);
});

test('a person who resumes questions that reached only the hand-over comment without answering them gets the questions into the prompt of the next implementer', async (t) => {
  const prompt = await resumedImplementer(t, 'editIssueBody', ANSWERED.slice(0, 1));
  assert.match(prompt, /## Answer of a person to the hand-over[\s\S]*Which name\?/);
});
