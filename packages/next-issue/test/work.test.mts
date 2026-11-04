import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { processIssue } from '../src/pipeline.mts';
import { STATE_DIR } from '../src/state.mts';
import type { Verdict } from '../src/verdict.mts';
import { APPROVE, changes, harness, ISSUE, roles, SAVED, stages } from './harness.mts';

test('a clean run implements, reviews and finishes', async (t) => {
  const target = await harness(t);
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reason, undefined);
  assert.equal(report.pr, 101);
  assert.equal(report.reviewRounds, 1);
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.ready, [101]);
  assert.equal(await target.state(), undefined);
  assert.deepEqual(target.deleted, ['7']);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a user with several issues at once gets their worktrees made one at a time', async (t) => {
  const target = await harness(t);
  const ports = target.context.ports;
  let active = 0;
  let most = 0;
  const addWorktree = ports.addWorktree;
  ports.addWorktree = async (...args) => {
    active += 1;
    most = Math.max(most, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return addWorktree(...args);
  };
  await Promise.all([
    processIssue(target.context, ISSUE),
    processIssue(target.context, { ...ISSUE, number: 8 }),
  ]);
  assert.deepEqual(target.branches.toSorted(), ['7', '8']);
  assert.equal(most, 1);
});

test("a user gets the pull request titled with the subject of the implementer's commit", async (t) => {
  const target = await harness(t, { implementerText: ['Done.\ncommit: feat: add the flag'] });
  await target.run();
  assert.deepEqual(target.titles, ['feat: add the flag']);
});

test('a user who resumes an implemented issue gets the pull request titled with the saved subject', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: { ...SAVED, phase: 'implemented', pr: undefined, title: 'feat: add the saved flag' },
  });
  await target.run();
  assert.deepEqual(target.titles, ['feat: add the saved flag']);
});

test('a user who resumes from a state file without a title gets a conventional pull request title', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: { ...SAVED, phase: 'implemented', pr: undefined },
  });
  await target.run();
  assert.deepEqual(target.titles, ['fix: resolve issue #7']);
});

test('a base that stays behind goes to the log', async (t) => {
  const target = await harness(t, { baseUpdated: false });
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], 1);
});

test('a base that the harness fast-forwards writes no such event', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.equal(target.context.recorder.summary().counts['base.behind'], undefined);
});

test('the status labels go to the issue and to the pull request', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.labels, [
    { kind: 'issue', number: 7, label: 'status:in-progress' },
    { kind: 'issue', number: 7, label: 'status:in-review' },
    { kind: 'pr', number: 101, label: 'status:in-review' },
    { kind: 'issue', number: 7, label: 'status:done' },
    { kind: 'pr', number: 101, label: 'status:done' },
  ]);
});

test('a failed build gives the logs to the fixer and then reviews', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'fixer', 'reviewer']);
  assert.match(target.prompts[1]!.prompt, /the failed job logs/);
  assert.equal(target.pushes, 2);
});

test('a user whose branch is named after the issue number gets the checks read from the pull request number', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(new Set(target.checked), new Set([101]));
});

test('a build that fails after the approval keeps the issue open', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['pass', 'fail'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'check budget');
  assert.deepEqual(target.ready, []);
  assert.equal(
    target.labels.some((entry) => entry.label === 'status:done'),
    false,
  );
});

test('a build that fails after the approval starts a fix round', async (t) => {
  const target = await harness(t, {
    checks: ['pass', 'fail', 'pass'],
    verdicts: [APPROVE, APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  assert.deepEqual(target.ready, [101]);
});

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
  assert.equal(report.pr, undefined);
  assert.equal(target.pushes, 0);
});

test('an implementer that changes nothing on a branch already ahead of the base gets a pull request with the title of the earlier commit', async (t) => {
  const target = await harness(t, { commits: [false], earlier: 'fix: earlier work' });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 1);
  assert.deepEqual(target.titles, ['fix: earlier work']);
});

test('a user whose issue is handed over before a pull request exists gets the reason as a comment on the issue', async (t) => {
  const target = await harness(t, { commits: [false] });
  await target.run();
  assert.equal(target.issueNotes.length, 1);
  assert.equal(target.issueNotes[0]!.number, 7);
  assert.match(target.issueNotes[0]!.body, /^next-issue needs help: /);
  assert.deepEqual(target.comments, []);
});

test('a user whose issue is handed over after the pull request exists gets the reason on the pull request only', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, checks: ['fail'] });
  await target.run();
  assert.match(target.comments.at(-1)!, /needs help: /);
  assert.deepEqual(target.issueNotes, []);
});

test('a run that finds a corrupt state file reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{ "issue": 7');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json is not valid JSON/);
  assert.deepEqual(roles(target), []);
});

test('a run that finds a state file of the wrong shape reports an error that names the file and starts no agent', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:todo', 'status:in-progress'] },
  });
  const folder = join(target.context.repo.root, STATE_DIR);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '7.json'), '{}');
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /7\.json does not hold a valid state/);
  assert.deepEqual(roles(target), []);
});

test('a fixer that changes nothing hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['fail'], commits: [true, false] });
  const report = await target.run();
  assert.equal(report.reason, 'no fix commit');
  assert.equal(target.pushes, 1);
});

test('a check wait that runs out of time hands the issue to a person', async (t) => {
  const target = await harness(t, { checks: ['timeout'] });
  const report = await target.run();
  assert.equal(report.reason, 'checks timeout');
});

test('a person who pushes to the pull request during the check wait gets the issue handed over', async (t) => {
  const target = await harness(t, { checks: ['moved'] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'pull request moved');
});

test('a repository without checks goes straight to the review', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  assert.equal((await target.run()).outcome, 'done');
});

test('a reviewer without a verdict hands the issue to a person', async (t) => {
  const target = await harness(t, { verdicts: [] });
  const report = await target.run();
  assert.equal(report.reason, 'no verdict');
});

test('a reviewer that says request_changes with no finding still approves', async (t) => {
  const target = await harness(t, {
    verdicts: [
      { verdict: 'request_changes', summary: 'Good.', findings: [] } as unknown as Verdict,
    ],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.reviewRounds, 1);
  assert.match(target.comments[0]!, /Review: approved/);
});

test('a verdict of the wrong shape counts as no verdict', async (t) => {
  const target = await harness(t, {
    verdicts: [{ summary: 'x' } as unknown as Verdict],
  });
  assert.equal((await target.run()).reason, 'no verdict');
});

test('the reviewer can run commands in the worktree', async (t) => {
  const target = await harness(t);
  await target.run();
  const reviewer = target.profiles.find((entry) => entry.role === 'reviewer')!;
  assert.equal(reviewer.tools.includes('-bash'), false);
  assert.match(target.prompts.at(-1)!.prompt, /run commands to prove what you say/);
});

test('a change that the reviewer leaves never reaches a commit', async (t) => {
  const target = await harness(t, {
    reviewerWrites: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
});

test('a diff that is too long is cut before the reviewer reads it', async (t) => {
  const target = await harness(t, { config: { diffMaxChars: 20 }, diff: 'x'.repeat(50) });
  assert.equal((await target.run()).outcome, 'done');
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /The diff is cut here, after 20 characters\./);
  assert.equal(prompt.includes('x'.repeat(21)), false);
});

test('a diff that fits reaches the reviewer whole', async (t) => {
  const target = await harness(t, { diff: 'the whole diff' });
  await target.run();
  const prompt = target.prompts.at(-1)!.prompt;
  assert.match(prompt, /the whole diff/);
  assert.equal(prompt.includes('cut here'), false);
});

test('a step that throws gives the error outcome and hands the issue over', async (t) => {
  const target = await harness(t, { fail: 'push' });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the port broke/);
  assert.equal(target.labels.at(-1)?.label, 'status:needs-human');
  assert.equal((await target.state())?.phase, 'implemented');
});

test('a saved state carries on and does not implement again', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: {
      issue: 7,
      phase: 'review',
      branch: 'issue-7',
      pr: 101,
      ciFixes: 2,
      reviewRounds: 1,
      reviewLog: [{ round: 1, findings: '- old' }],
    },
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 2);
  assert.equal(report.reviewRounds, 2);
  assert.deepEqual(roles(target), ['reviewer']);
  assert.deepEqual(target.branches, ['issue-7']);
  assert.deepEqual(target.starts, [false]);
});

test('a new issue asks for its worktree to start from the base branch', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(target.starts, [true]);
});

test('a watcher sees each limited round with its count and its limit', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    commits: [true, 'oxlint: x is never used', true, true],
    checks: ['pass', 'fail', 'pass'],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.deepEqual(
    stages(target).filter((stage) => /\//.test(stage)),
    ['review 1/5', 'review fix 1/5', 'commit fix 1/10', 'checks fix 1/5', 'review 2/5'],
  );
});

test('an agent that commits its own work counts as progress', async (t) => {
  const target = await harness(t, { commits: [false], selfCommit: true });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.pushes, 1);
});

test('the checks wait for the commit that was pushed', async (t) => {
  const target = await harness(t, { checks: ['fail', 'pass'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.head),
    ['1', '2', '2'],
  );
});

test('a repository without checks pays the grace time once', async (t) => {
  const target = await harness(t, { checks: ['none'] });
  await target.run();
  assert.deepEqual(
    target.waits.map((options) => options.graceMs),
    [60_000, 0],
  );
});

test('a commit that the reviewer makes does not stay on the branch', async (t) => {
  const target = await harness(t, {
    reviewerCommits: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
  assert.equal(await target.context.ports.revision('worktree'), '2');
});
