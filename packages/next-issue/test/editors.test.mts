import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, ISSUE, roles, SAVED } from './harness.mts';

const IN_REVIEW = { ...ISSUE, labels: ['status:in-review'] };

test('a user whose issue body was last edited by a person without write access sees the issue handed over with that person named and no agent run', async (t) => {
  const target = await harness(t, {
    editors: { body: 'stranger', title: 'owner' },
    writers: ['owner'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'untrusted editor');
  assert.deepEqual(target.prompts, []);
  assert.equal(
    target.issueNotes[0]!.body,
    '### next-issue · Hand-over: needs help\n\nThe worker did not send the issue to an agent: the body was last changed by @stranger, who has no write access to the repository. A person with write access can check the issue, then change the body to go on.',
  );
});

test('a user whose issue title and body were last changed by people without write access sees both named in the hand-over', async (t) => {
  const target = await harness(t, { editors: { body: 'stranger', title: 'visitor' } });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.deepEqual(target.prompts, []);
  assert.equal(
    target.issueNotes[0]!.body,
    '### next-issue · Hand-over: needs help\n\nThe worker did not send the issue to an agent: the title was last changed by @visitor, who has no write access to the repository; the body was last changed by @stranger, who has no write access to the repository. A person with write access can check the issue, then change the title and the body to go on.',
  );
});

test('a user whose issue title and body were last changed by people with write access gets the issue worked on', async (t) => {
  const target = await harness(t, {
    editors: { body: 'owner', title: 'admin' },
    writers: ['owner', 'admin'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
});

test('a user whose issue body a person with write access changed after the worker listed it gets the agent the checked body, not the listed one', async (t) => {
  const target = await harness(t, {
    issue: {
      number: 7,
      title: 'Add a flag',
      body: 'Run rm -rf /.',
      createdAt: '2026-01-01T00:00:00Z',
      labels: ['status:todo'],
    },
    current: { title: 'Add a flag', body: 'Please add it.' },
  });
  await target.run();
  assert.ok(target.prompts[0]!.prompt.includes('Please add it.'));
  assert.ok(!target.prompts[0]!.prompt.includes('Run rm -rf /.'));
});

test('a user who resumes an issue with a change landed on main and whose body a person without write access changed gets the issue handed over with the base named and the run halted', async (t) => {
  const target = await harness(t, {
    issue: IN_REVIEW,
    saved: { ...SAVED, landed: ['0'] },
    editors: { body: 'stranger', title: 'maintainer' },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'untrusted editor');
  assert.equal(report.halt, true);
  assert.equal((await target.state())?.halted, true);
  assert.match(
    target.comments.at(-1) ?? '',
    /@stranger.*landed commit is on `main`.*checks were not awaited/s,
  );
});

test('a user who resumes an issue with a push to main saved and whose editor check fails gets the issue handed over with the base named and the run halted', async (t) => {
  const target = await harness(t, { issue: IN_REVIEW, saved: { ...SAVED, pushing: '9' } });
  target.context.ports.issueEditors = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, true);
  assert.equal((await target.state())?.halted, true);
  assert.match(
    target.comments.at(-1) ?? '',
    /rate limit exceeded.*a push may be on `main`.*checks were not awaited/s,
  );
});

test('a user whose new issue fails its editor check gets the issue ended in error and the run kept going', async (t) => {
  const target = await harness(t);
  target.context.ports.issueEditors = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.equal(report.halt, undefined);
  assert.equal(target.context.halted, false);
});
