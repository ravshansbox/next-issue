import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes, type Harness, harness, ISSUE, APPROVE } from './harness.mts';

function link(sha: string): string {
  return `[\`${sha}\`](https://github.com/acme/tool/commit/${sha})`;
}

function notesHeaded(target: Harness, heading: string): string[] {
  return target.comments.filter((body) => body.startsWith(`### next-issue · ${heading}\n`));
}

test('a user whose implementer commits gets a comment on the issue with the linked commit and the summary of the implementer', async (t) => {
  const target = await harness(t, {
    implementerText: ['Done.\nsummary: Adds the --quiet flag.\ncommit: feat: add the flag'],
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(notesHeaded(target, 'Implementer: committed'), [
    `### next-issue · Implementer: committed\n\n${link('1')}\n\nAdds the --quiet flag.`,
  ]);
});

test('a user whose implementer gives no summary still gets a comment on the issue with the linked commit only', async (t) => {
  const target = await harness(t);
  await target.run();
  assert.deepEqual(notesHeaded(target, 'Implementer: committed'), [
    `### next-issue · Implementer: committed\n\n${link('1')}`,
  ]);
});

test('a user whose implementer writes a long summary gets the summary cut in the comment on the issue', async (t) => {
  const target = await harness(t, {
    implementerText: [`summary: ${'a'.repeat(400)}\ncommit: feat: add the flag`],
  });
  await target.run();
  const [note] = notesHeaded(target, 'Implementer: committed');
  assert.equal(
    note,
    `### next-issue · Implementer: committed\n\n${link('1')}\n\n${'a'.repeat(299)}…`,
  );
});

test('a user whose fixer commits a fix for review findings gets a comment on the issue with the linked commit and the summary of the fixer', async (t) => {
  const target = await harness(t, {
    verdicts: [changes('Rename it.'), APPROVE],
    fixerText: 'summary: Renames the flag.\ncommit: fix: rename the flag',
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(notesHeaded(target, 'Fixer: fixed review'), [
    `### next-issue · Fixer: fixed review\n\n${link('2')}\n\nRenames the flag.`,
  ]);
  const order = target.comments.map((body) => body.split('\n')[0]);
  assert.deepEqual(order.slice(0, 4), [
    '### next-issue · Implementer: committed',
    '### next-issue · Review: changes requested',
    '### next-issue · Fixer: fixed review',
    '### next-issue · Review: approved',
  ]);
});

test('a user whose fixer commits a fix for failed checks on the base gets a comment on the issue with the linked commit and the summary of the fixer', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'summary: Fixes the broken test.\ncommit: fix: the test',
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(notesHeaded(target, 'Fixer: fixed checks'), [
    `### next-issue · Fixer: fixed checks\n\n${link('3')}\n\nFixes the broken test.`,
  ]);
});

test('a user whose fixer commits a fix for failed local checks gets a comment on the issue with the linked commit and the summary of the fixer', async (t) => {
  const target = await harness(t, {
    checkCodes: [0, 0, 0, 1],
    fixerText: 'summary: Makes the test pass.\ncommit: fix: make the test pass',
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(notesHeaded(target, 'Fixer: fixed local checks'), [
    `### next-issue · Fixer: fixed local checks\n\n${link('3')}\n\nMakes the test pass.`,
  ]);
});

test('a user whose hook fixer commits gets a comment on the issue with the linked commit and the summary of the hook fix after the comment of the implementer', async (t) => {
  const target = await harness(t, {
    commits: ['oxlint: x is never used', true],
    implementerText: [
      'summary: Adds the flag.\ncommit: feat: add the flag',
      'summary: Drops the unused x.\ncommit: feat: add the flag',
    ],
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.comments.slice(0, 2), [
    `### next-issue · Implementer: committed\n\n${link('1')}\n\nAdds the flag.`,
    `### next-issue · Fixer: fixed commit hook\n\n${link('1')}\n\nDrops the unused x.`,
  ]);
});

test('a user whose conflict fixer commits gets a comment on the issue with the linked commit and the summary of the fixer', async (t) => {
  const target = await harness(t, {
    merges: [['src/a.ts']],
    fixerText: 'summary: Keeps both changes.\ncommit: chore: merge main',
  });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(notesHeaded(target, 'Fixer: resolved conflict'), [
    `### next-issue · Fixer: resolved conflict\n\n${link('2')}\n\nKeeps both changes.`,
  ]);
});

test('a user whose change lands with passing checks gets a comment on the issue that links every landed commit in order before it is closed', async (t) => {
  const target = await harness(t, {
    baseChecks: ['fail'],
    fixerText: 'commit: fix: the test',
  });
  let closedBefore: number[] | undefined;
  const commentOnIssue = target.context.ports.commentOnIssue;
  target.context.ports.commentOnIssue = async (repo, issue, body) => {
    if (body.includes('Worker: landed')) {
      closedBefore = [...target.closed];
    }
    return commentOnIssue(repo, issue, body);
  };
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.landed, ['2', '4']);
  assert.equal(
    target.comments.at(-1),
    `### next-issue · Worker: landed\n\n- ${link('2')}\n- ${link('4')}`,
  );
  assert.deepEqual(closedBefore, []);
  assert.deepEqual(target.closed, [7]);
});

test('a user whose run stops before the landed comment is posted gets it posted once by the next run before the issue is closed', async (t) => {
  const first = await harness(t);
  const commentOnIssue = first.context.ports.commentOnIssue;
  first.context.ports.commentOnIssue = async (repo, issue, body) => {
    if (body.includes('Worker: landed')) {
      first.stopNow();
      throw new Error('The run stopped.');
    }
    return commentOnIssue(repo, issue, body);
  };
  assert.equal((await first.run()).outcome, 'stopped');
  assert.deepEqual(notesHeaded(first, 'Worker: landed'), []);
  const target = await harness(t, { saved: await first.state(), issue: ISSUE });
  assert.equal((await target.run()).outcome, 'done');
  assert.deepEqual(target.comments, [`### next-issue · Worker: landed\n\n- ${link('2')}`]);
  assert.deepEqual(target.closed, [7]);
});

test('a user whose comment on a commit fails gets a logged event and the run goes on to land the change', async (t) => {
  const target = await harness(t);
  const commentOnIssue = target.context.ports.commentOnIssue;
  target.context.ports.commentOnIssue = async (repo, issue, body) => {
    if (body.includes('Implementer: committed')) {
      throw new Error('gh: HTTP 502');
    }
    return commentOnIssue(repo, issue, body);
  };
  assert.equal((await target.run()).outcome, 'done');
  const failed = target.events.find((record) => record.kind === 'comment.fail');
  assert.equal(failed?.error, 'gh: HTTP 502');
  assert.deepEqual(target.landed, ['2']);
});
