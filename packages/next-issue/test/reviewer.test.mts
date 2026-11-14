import assert from 'node:assert/strict';
import { access, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRequest } from '../src/agents.mts';
import { commitAll } from '../src/git-commit.mts';
import { pushToBase, squashOnto } from '../src/git-land.mts';
import {
  diff,
  discardChanges,
  isDirty,
  latestSubject,
  type Repo,
  revision,
  setAside,
} from '../src/git.mts';
import type { Recorder } from '../src/observe.mts';
import type { Verdict } from '../src/verdict.mts';
import { addWorktree, findWorktree, removeWorktree } from '../src/worktree.mts';
import { clones, git } from './clones.mts';
import { APPROVE, changes, type Harness, harness, ISSUE, SAVED } from './harness.mts';
import { tempDir } from './temp-dir.mts';

async function gitRepo(): Promise<Repo> {
  const { repo } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  return repo;
}

function withGit(target: Harness, reviewer: (worktree: string) => Promise<unknown>): void {
  const { ports } = target.context;
  const fake = ports.runAgent;
  Object.assign(ports, {
    addWorktree,
    commitAll,
    diff,
    discardChanges,
    findWorktree,
    isDirty,
    latestSubject,
    removeWorktree,
    revision,
    setAside,
    runAgent: async (recorder: Recorder, request: AgentRequest) => {
      if (request.name === 'reviewer') {
        await reviewer(request.cwd);
      } else {
        await writeFile(join(request.cwd, `${request.name}.txt`), `${request.name}\n`);
      }
      return fake(recorder, request);
    },
  });
}

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

test('a reviewer that checks out another branch leaves that branch where it was and gets branch 7 put back, so the fixer commit moves branch 7', async (t) => {
  const repo = await gitRepo();
  await git(repo.root, 'branch', 'other', 'origin/main');
  const other = await git(repo.root, 'rev-parse', 'other');
  const target = await harness(t, {
    root: repo.root,
    pressDuring: 'reviewer',
    verdicts: [changes('The count is wrong.')],
  });
  withGit(target, (worktree) => git(worktree, 'checkout', '-q', 'other'));
  assert.equal((await target.run()).outcome, 'stopped');
  const worktree = (await findWorktree(repo, '7'))!;
  assert.equal(await git(repo.root, 'rev-parse', 'other'), other);
  assert.equal(await git(worktree, 'branch', '--show-current'), '7');
  assert.equal(await git(repo.root, 'rev-parse', '7'), await revision(worktree));
  await git(repo.root, 'cat-file', '-e', '7:fixer.txt');
  assert.ok(target.events.some((record) => record.kind === 'review.discard'));
});

test('a user who stops and resumes issue 7 after a reviewer detached HEAD still has the fixer commit on branch 7', async (t) => {
  const repo = await gitRepo();
  const first = await harness(t, {
    root: repo.root,
    pressDuring: 'reviewer',
    verdicts: [changes('The count is wrong.')],
  });
  withGit(first, (worktree) => git(worktree, 'checkout', '-q', '--detach', 'HEAD~1'));
  assert.equal((await first.run()).outcome, 'stopped');
  const resumed = await harness(t, { root: repo.root, stopNowDuring: 'reviewer' });
  withGit(resumed, async () => undefined);
  assert.equal((await resumed.run()).outcome, 'stopped');
  const worktree = (await findWorktree(repo, '7'))!;
  assert.equal(await git(worktree, 'branch', '--show-current'), '7');
  await git(worktree, 'cat-file', '-e', 'HEAD:fixer.txt');
});

function squashStoppedInHook(target: Harness, root: string): { head: () => string } {
  let head = '';
  target.context.ports.squashOnto = async (worktree, base, remote, message) => {
    head = await revision(worktree);
    const hook = join(root, 'pre-commit');
    const started = join(root, 'hook-started');
    await writeFile(hook, `#!/bin/sh\ntouch '${started}'\nsleep 30\n`);
    await chmod(hook, 0o755);
    await git(worktree, 'config', 'core.hooksPath', root);
    const squash = squashOnto(worktree, base, remote, message);
    let settled = false;
    void squash.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (
      !settled &&
      !(await access(started).then(
        () => true,
        () => false,
      ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    target.stopNow();
    return squash;
  };
  return { head: () => head };
}

test('a user who stops now during the squash hook keeps the change on branch 7, and the resumed reviewer sees it and it lands', async (t) => {
  const repo = await gitRepo();
  const hooks = await tempDir();
  const first = await harness(t, { root: repo.root });
  withGit(first, async () => undefined);
  const squash = squashStoppedInHook(first, hooks);
  assert.equal((await first.run()).outcome, 'stopped');
  const worktree = (await findWorktree(repo, '7'))!;
  assert.equal(await git(repo.root, 'rev-parse', '7'), squash.head());
  assert.equal(await git(worktree, 'status', '--porcelain'), '');
  await git(worktree, 'config', '--unset', 'core.hooksPath');
  const resumed = await harness(t, { root: repo.root });
  withGit(resumed, async () => undefined);
  Object.assign(resumed.context.ports, { squashOnto, pushToBase });
  assert.equal((await resumed.run()).outcome, 'done');
  const reviewer = resumed.prompts.find((entry) => entry.role === 'reviewer')!;
  assert.match(reviewer.prompt, /\+\+\+ b\/implementer\.txt/);
  await git(repo.root, 'fetch', '-q', 'origin');
  await git(repo.root, 'cat-file', '-e', 'origin/main:implementer.txt');
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

test('a commit that the reviewer makes does not stay on the branch', async (t) => {
  const target = await harness(t, {
    reviewerCommits: true,
    verdicts: [changes('The count is wrong.'), APPROVE],
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(target.discards, 2);
  assert.equal(await target.context.ports.revision('worktree'), '3');
});

test('the reviewer gets the reply of the implementer in its prompt', async (t) => {
  const reply = 'The test failed first: expected 2, got 1.\ncommit: fix: count the issues';
  const target = await harness(t, { implementerText: [reply] });
  assert.equal((await target.run()).outcome, 'done');
  const reviewer = target.prompts.find((entry) => entry.role === 'reviewer')!;
  assert.match(
    reviewer.prompt,
    /## Reply of the implementer\nThe test failed first: expected 2, got 1\./,
  );
});

test('a user who resumes a run after the implementer gets its saved reply to the reviewer', async (t) => {
  const target = await harness(t, {
    issue: { ...ISSUE, labels: ['status:in-progress'] },
    saved: {
      ...SAVED,
      phase: 'implemented',
      reviewRounds: 0,
      reviewLog: [],
      implementerReply: 'The test failed first.',
    },
  });
  assert.equal((await target.run()).outcome, 'done');
  const reviewer = target.prompts.find((entry) => entry.role === 'reviewer')!;
  assert.match(reviewer.prompt, /## Reply of the implementer\nThe test failed first\./);
});

test('a later reviewer gets the reply of the fixer in its prompt', async (t) => {
  const target = await harness(t, {
    fixerText: 'The test failed first: expected 2, got 1.\ncommit: fix: count the issues',
    verdicts: [changes('No failing run.'), APPROVE],
  });
  assert.equal((await target.run()).outcome, 'done');
  const reviewer = target.prompts.filter((entry) => entry.role === 'reviewer').at(-1)!;
  assert.match(
    reviewer.prompt,
    /## Reply of the fixer\nThe test failed first: expected 2, got 1\./,
  );
});
