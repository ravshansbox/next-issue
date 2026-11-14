import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { REVIEWING } from '../src/agents.mts';
import { revision } from '../src/git.mts';
import { HUNT_FILE, hunt, hunter, huntWorktree } from '../src/hunt.mts';
import { ISSUE_SECTIONS } from '../src/issue-format.mts';
import { clones, commit, git } from './clones.mts';
import { harness, ISSUE } from './harness.mts';

test('a user who hunts with next-issue.hunt.md sees the hunter follow it in the hunt worktree with read-only tools', async (t) => {
  const target = await harness(t);
  await writeFile(join(target.context.repo.root, HUNT_FILE), 'Look only at the parser.\n');
  await hunt(target.context);
  assert.deepEqual(target.hunts, ['main']);
  assert.deepEqual(target.profiles, [{ role: 'hunter', tools: REVIEWING.tools }]);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /Look only at the parser\./);
  assert.doesNotMatch(prompt, /Read the whole repository/);
});

test('a user who hunts with no next-issue.hunt.md sees the hunter get the built-in prompt', async (t) => {
  const target = await harness(t);
  await hunt(target.context);
  assert.match(target.prompts[0]!.prompt, /Read the whole repository/);
});

test('a user who hunts sees the hunter told to file one ready issue in the issue format after a search for duplicates, with no test run and no change', async (t) => {
  const target = await harness(t);
  await hunt(target.context);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /one issue/);
  assert.match(prompt, /most serious finding/);
  assert.match(prompt, /--label "status:todo"/);
  assert.match(prompt, /duplicate/);
  assert.match(prompt, /Run no test suite/);
  assert.match(prompt, /Change no file/);
  for (const section of ISSUE_SECTIONS) {
    assert.match(prompt, new RegExp(`## ${section}`));
  }
});

test('a user who hunts sees the hunter told to add the source label, which the harness creates first', async (t) => {
  const target = await harness(t);
  const order: string[] = [];
  const ports = target.context.ports;
  const runAgent = ports.runAgent;
  ports.ensureLabel = async (_repo, label) => {
    order.push(`ensure ${label}`);
  };
  ports.runAgent = async (recorder, request) => {
    order.push('hunter');
    return runAgent(recorder, request);
  };
  await hunt(target.context);
  assert.deepEqual(order, ['ensure source:hunt', 'hunter']);
  assert.match(target.prompts[0]!.prompt, /--label "status:todo" --label "source:hunt"/);
});

test('a user who sets labels.hunt sees the hunter add that label', async (t) => {
  const defaults = await harness(t);
  const target = await harness(t, {
    config: { labels: { ...defaults.context.config.labels, hunt: 'bot' } },
  });
  await hunt(target.context);
  assert.match(target.prompts[0]!.prompt, /--label "bot"/);
});

test('a user who sets an empty labels.ready sees the hunter add only the source label', async (t) => {
  const defaults = await harness(t);
  const target = await harness(t, {
    config: { labels: { ...defaults.context.config.labels, ready: '' } },
  });
  await hunt(target.context);
  assert.match(target.prompts[0]!.prompt, /gh issue create --label "source:hunt" --title/);
});

test('a user who hunts sees the filed issue in the run log', async (t) => {
  const target = await harness(t, {
    hunterText: 'Found it.\nissue: https://github.com/acme/tool/issues/9',
  });
  await hunt(target.context);
  const event = target.events.find((record) => record.kind === 'hunt.issue');
  assert.equal(event?.url, 'https://github.com/acme/tool/issues/9');
});

test('a user whose hunter fails sees a hunt.error event', async (t) => {
  const target = await harness(t, { fail: 'runAgent' });
  await assert.rejects(hunt(target.context), /the port broke/);
  assert.ok(target.events.some((record) => record.kind === 'hunt.error'));
});

test('a user who hunts gets a worktree at the remote base', async () => {
  const { repo, other } = await clones();
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  const path = await huntWorktree(repo, 'main', 'origin');
  assert.equal(path, join(repo.root, '.worktrees', 'hunt'));
  assert.equal(await revision(path), pushed);
});

test('a user who hunts again gets the hunt worktree reset to the new remote base', async () => {
  const { repo, other } = await clones();
  const path = await huntWorktree(repo, 'main', 'origin');
  await writeFile(join(path, 'a.txt'), 'changed\n');
  await writeFile(join(path, 'stray.txt'), 'stray\n');
  await commit(path, 'local.txt');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.equal(await huntWorktree(repo, 'main', 'origin'), path);
  assert.equal(await revision(path), pushed);
  assert.equal(await git(path, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(path, 'stray.txt')), false);
});

test('a user who hunts sees the hunter count only issues that the watch can claim', async (t) => {
  const open = [7, 8, 9, 10].map((number) => ({ ...ISSUE, number }));
  open[2]!.labels = ['status:todo', 'status:in-progress'];
  open[3]!.labels = ['status:todo', 'status:done'];
  const target = await harness(t, { open, config: { huntCap: 3 } });
  const asked: string[][] = [];
  const ports = target.context.ports;
  const list = ports.openIssues;
  ports.openIssues = async (repo, limit, labels) => {
    asked.push(labels);
    return list(repo, limit, labels);
  };
  ports.openBlockers = async (_repo, number) => (number === 8 ? ['#3'] : []);
  const watched = hunter(target.context);
  assert.equal(watched.cap, 3);
  assert.deepEqual(
    (await watched.ready()).map((issue) => issue.number),
    [7],
  );
  assert.deepEqual(asked, [['status:todo']]);
});

test('a user who hunts sees each back-off wait of the hunter in the run log', async (t) => {
  const target = await harness(t);
  await hunter(target.context).wait(1, AbortSignal.abort());
  const event = target.events.find((record) => record.kind === 'hunt.wait');
  assert.equal(event?.minutes, 1);
});

test('a user who hunts sees the hunter busy only during a hunt', async (t) => {
  const target = await harness(t);
  const watched = hunter(target.context);
  assert.equal(watched.busy(), false);
  const hunting = watched.hunt();
  assert.equal(watched.busy(), true);
  await hunting;
  assert.equal(watched.busy(), false);
});

test('a user whose hunt fails sees the hunter report the failure so the watch backs off', async (t) => {
  const target = await harness(t, { fail: 'runAgent' });
  assert.equal(await hunter(target.context).hunt(), false);
});

test('a user whose hunt files an issue sees the hunter report the success', async (t) => {
  const target = await harness(t, {
    hunterText: 'Found it.\nissue: https://github.com/acme/tool/issues/9',
  });
  assert.equal(await hunter(target.context).hunt(), true);
});

test('a user whose hunt replies issue: none sees the hunter report it so the watch backs off', async (t) => {
  const target = await harness(t, { hunterText: 'Nothing found.\nissue: none' });
  assert.equal(await hunter(target.context).hunt(), false);
});

test('a user whose hunt reply has no issue line sees the hunter report it so the watch backs off', async (t) => {
  const target = await harness(t, { hunterText: 'Nothing found.' });
  assert.equal(await hunter(target.context).hunt(), false);
});
