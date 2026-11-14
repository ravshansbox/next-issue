import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { AgentRequest } from '../src/agents.mts';
import { commitAll, HookError } from '../src/git-commit.mts';
import { pushToBase, squashOnto } from '../src/git-land.mts';
import { abortMerge, commitMerge, startMerge } from '../src/git-merge.mts';
import { diff, discardChanges, isDirty, latestSubject, revision, setAside } from '../src/git.mts';
import type { Recorder } from '../src/observe.mts';
import { addWorktree, findWorktree, removeWorktree } from '../src/worktree.mts';
import { clones, commit, git } from './clones.mts';
import { type Harness, harness, ISSUE, roles } from './harness.mts';

test('a user whose base branch moved without a conflict gets the base merged with no agent and no check fix spent', async (t) => {
  const target = await harness(t, { merges: [[]] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 0);
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.match(target.messages.at(-1)!, /^fix: work on #7\n/);
});

test('a user whose change conflicts with the base branch gets the fixer to resolve it from the check budget, and the change landed', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts', 'README.md']] });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer']);
  const fixer = target.prompts.find((entry) => entry.role === 'fixer')!.prompt;
  assert.match(fixer, /src\/a\.ts\nREADME\.md/);
  assert.match(fixer, /conflict markers/);
  assert.equal(target.landed.length, 1);
});

test('a user whose change conflicts with the base branch after the check budget is used up gets the issue handed over with nothing landed', async (t) => {
  const target = await harness(t, { config: { maxCiFixes: 0 }, merges: [['src/a.ts']] });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.deepEqual(roles(target), ['implementer', 'reviewer']);
  assert.deepEqual(target.mergeAborts, ['1']);
  assert.deepEqual(target.landed, []);
  assert.match(target.comments.at(-1)!, /conflicts with main, and the limit of 0 check fixes/);
});

test('a user whose fixer leaves the conflict unresolved gets the issue handed over and the merge undone', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts']], mergeResolved: false });
  const report = await target.run();
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(report.ciFixes, 1);
  assert.deepEqual(target.mergeAborts, ['1']);
  assert.deepEqual(target.landed, []);
  assert.match(target.comments.at(-1)!, /left the conflict with main unresolved/);
});

test('a user whose fixer fails while it resolves a conflict gets the merge undone', async (t) => {
  const target = await harness(t, { merges: [['src/a.ts']], fixerThrows: true });
  const report = await target.run();
  assert.equal(report.outcome, 'error');
  assert.match(report.reason!, /the fixer timed out/);
  assert.deepEqual(target.mergeAborts, ['1']);
});

test('a user whose merge of the base fails in a hook gets the hook output to the fixer and the change landed with its own subject', async (t) => {
  const target = await harness(t, {
    merges: [[]],
    mergeHook: 'commitlint: subject may not be empty',
    fixerText: 'commit: chore: merge the base',
  });
  const report = await target.run();
  assert.equal(report.outcome, 'done');
  assert.match(target.messages[1]!, /^chore: merge origin\/main\n\nRefs #/);
  assert.match(target.messages[2]!, /^chore: merge the base\n/);
  assert.match(target.messages.at(-1)!, /^fix: work on #7\n/);
  assert.match(target.prompts.at(-1)!.prompt, /commitlint: subject may not be empty/);
});

test('a user who resumes an issue whose squash failed after a merge of the base gets the change landed with its own subject', async (t) => {
  const failed = await harness(t, { config: { maxCommitFixes: 0 }, merges: [[]] });
  failed.context.ports.squashOnto = async () => {
    throw new HookError('commitlint: subject may not be empty');
  };
  const report = await failed.run();
  assert.equal(report.outcome, 'error');
  assert.match(failed.messages.at(-1)!, /^chore: merge origin\/main\n/);
  assert.equal((await failed.state())?.title, 'fix: work on #7');
  const body = failed.issueNotes.at(-1)!.body;
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
  assert.match(answered.messages.at(-1)!, /^fix: work on #7\n/);
});

type Fixer = (worktree: string) => Promise<unknown>;

async function realMerge(t: TestContext, fixer: Fixer): Promise<{ target: Harness; base: string }> {
  const { repo, other } = await clones();
  await git(repo.root, 'config', 'user.name', 't');
  await git(repo.root, 'config', 'user.email', 't@t');
  const target = await harness(t, { root: repo.root });
  const { ports } = target.context;
  const fake = ports.runAgent;
  Object.assign(ports, {
    abortMerge,
    addWorktree,
    commitAll,
    commitMerge,
    diff,
    discardChanges,
    findWorktree,
    isDirty,
    latestSubject,
    pushToBase,
    removeWorktree,
    revision,
    setAside,
    squashOnto,
    startMerge,
    runAgent: async (recorder: Recorder, request: AgentRequest) => {
      if (request.name === 'implementer') {
        await writeFile(join(request.cwd, 'a.txt'), 'branch\n');
        await writeFile(join(other, 'a.txt'), 'base\n');
        await writeFile(join(other, 'b.txt'), 'base\n');
        await git(other, 'add', '-A');
        await git(other, 'commit', '-q', '-m', 'base');
        await git(other, 'push', '-q', 'origin', 'main');
      }
      if (request.name === 'fixer') {
        await fixer(request.cwd);
      }
      return fake(recorder, request);
    },
  });
  return { target, base: other };
}

async function remoteMain(base: string): Promise<string> {
  await git(base, 'fetch', '-q', 'origin');
  return git(base, 'rev-parse', 'origin/main');
}

test('a user whose fixer commits the merge with a conflict marker left gets the merge undone, the issue handed over and nothing pushed', async (t) => {
  const { target, base } = await realMerge(t, (worktree) =>
    git(worktree, 'commit', '-qam', 'merge'),
  );
  const report = await target.run();
  const before = await git(base, 'rev-parse', 'HEAD');
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(await remoteMain(base), before);
});

test('a user whose fixer aborts the merge and commits its own change gets the issue handed over and no base change reverted', async (t) => {
  const { target, base } = await realMerge(t, async (worktree) => {
    await git(worktree, 'merge', '--abort');
    await writeFile(join(worktree, 'c.txt'), 'fixer\n');
    await git(worktree, 'add', 'c.txt');
    await git(worktree, 'commit', '-q', '-m', 'fixer');
  });
  const report = await target.run();
  const before = await git(base, 'rev-parse', 'HEAD');
  assert.equal(report.outcome, 'needs-human');
  assert.equal(report.reason, 'merge conflict');
  assert.equal(await remoteMain(base), before);
});

test('a user whose fixer commits a clean merge of the base gets the change landed as one commit on the base', async (t) => {
  const { target, base } = await realMerge(t, async (worktree) => {
    await writeFile(join(worktree, 'a.txt'), 'branch and base\n');
    await git(worktree, 'commit', '-qam', 'merge');
  });
  const report = await target.run();
  const before = await git(base, 'rev-parse', 'HEAD');
  assert.equal(report.outcome, 'done');
  const landed = await remoteMain(base);
  assert.equal(await git(base, 'rev-parse', `${landed}^`), before);
  assert.equal(await git(base, 'show', `${landed}:a.txt`), 'branch and base');
  assert.equal(await git(base, 'show', `${landed}:b.txt`), 'base');
});

test('a user whose base branch moves while the fixer resolves a conflict gets the change landed on top of the moved base with its changes kept', async (t) => {
  const { target, base } = await realMerge(t, async (worktree) => {
    await writeFile(join(worktree, 'a.txt'), 'branch and base\n');
    await git(worktree, 'add', 'a.txt');
    await commit(base, 'd.txt');
    await git(base, 'push', '-q', 'origin', 'main');
    await git(worktree, 'fetch', '-q', 'origin');
  });
  const report = await target.run();
  const moved = await git(base, 'rev-parse', 'HEAD');
  assert.equal(report.reason, undefined);
  assert.equal(report.outcome, 'done');
  const landed = await remoteMain(base);
  assert.equal(await git(base, 'rev-parse', `${landed}^`), moved);
  assert.equal(await git(base, 'show', `${landed}:d.txt`), 'd.txt');
  assert.equal(await git(base, 'show', `${landed}:a.txt`), 'branch and base');
});
