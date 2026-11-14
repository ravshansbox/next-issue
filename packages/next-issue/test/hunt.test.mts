import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { REVIEWING } from '../src/agents.mts';
import { revision } from '../src/git.mts';
import { HUNT_FILE, hunt, hunter, huntWorktree } from '../src/hunt.mts';
import { ISSUE_SECTIONS } from '../src/issue-format.mts';
import { ensureLabel } from '../src/labels.mts';
import { clones, commit, git } from './clones.mts';
import { installGh } from './fake-gh.mts';
import { harness, ISSUE } from './harness.mts';
import { tempDir } from './temp-dir.mts';

test('a user who hunts with next-issue.hunt.md sees the hunter follow it in the hunt worktree with read-only tools', async (t) => {
  const target = await harness(t);
  await writeFile(join(target.context.repo.root, HUNT_FILE), 'Look only at the parser.\n');
  await hunt(target.context, 1);
  assert.deepEqual(target.hunts, ['main']);
  assert.deepEqual(target.profiles, [{ role: 'hunter', tools: REVIEWING.tools }]);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /Look only at the parser\./);
  assert.doesNotMatch(prompt, /Read the whole repository/);
});

test('a user who hunts with no next-issue.hunt.md sees the hunter get the built-in prompt', async (t) => {
  const target = await harness(t);
  await hunt(target.context, 1);
  assert.match(target.prompts[0]!.prompt, /Read the whole repository/);
});

test('a user who hunts with one free place sees the hunter told to file at most one ready issue in the issue format after a search for duplicates, with no test run and no change', async (t) => {
  const target = await harness(t);
  await hunt(target.context, 1);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /File up to 1 issue,/);
  assert.match(prompt, /most serious findings first/);
  assert.match(prompt, /File nothing when you find no real problem/);
  assert.match(prompt, /--label "status:todo"/);
  assert.match(prompt, /duplicate/);
  assert.match(prompt, /Run no test suite/);
  assert.match(prompt, /Change no file/);
  for (const section of ISSUE_SECTIONS) {
    assert.match(prompt, new RegExp(`## ${section}`));
  }
});

test('a user who hunts in a repository without the ready label sees the harness create the ready and source labels before the hunter runs', async (t) => {
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
  await hunt(target.context, 1);
  assert.deepEqual(order, ['ensure status:todo', 'ensure source:hunt', 'hunter']);
  assert.match(target.prompts[0]!.prompt, /--label "status:todo" --label "source:hunt"/);
});

test('a user who sets labels.hunt sees the hunter add that label', async (t) => {
  const defaults = await harness(t);
  const target = await harness(t, {
    config: { labels: { ...defaults.context.config.labels, hunt: 'bot' } },
  });
  await hunt(target.context, 1);
  assert.match(target.prompts[0]!.prompt, /--label "bot"/);
});

test('a user who sets an empty labels.ready sees the hunter add only the source label, and the harness create only that label', async (t) => {
  const defaults = await harness(t);
  const target = await harness(t, {
    config: { labels: { ...defaults.context.config.labels, ready: '' } },
  });
  const ensured: string[] = [];
  target.context.ports.ensureLabel = async (_repo, label) => {
    ensured.push(label);
  };
  await hunt(target.context, 1);
  assert.deepEqual(ensured, ['source:hunt']);
  assert.match(
    target.prompts[0]!.prompt,
    /gh issue create --repo acme\/tool --label "source:hunt" --title/,
  );
});

test('a user who hunts sees the filed issue in the run log', async (t) => {
  const target = await harness(t, {
    hunterText: 'Found it.\nissue: https://github.com/acme/tool/issues/9',
  });
  await hunt(target.context, 1);
  const event = target.events.find((record) => record.kind === 'hunt.issue');
  assert.equal(event?.url, 'https://github.com/acme/tool/issues/9');
});

test('a user who hunts with three free places sees the hunter told to file up to three issues, the most serious first', async (t) => {
  const target = await harness(t);
  await hunt(target.context, 3);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /File up to 3 issues, your most serious findings first\./);
  assert.match(prompt, /one line in the form `issue: <url>` for each issue you filed/);
});

test('a user whose hunt files several issues sees a hunt.issue event for each in the run log', async (t) => {
  const target = await harness(t, {
    hunterText:
      'Found two.\nissue: https://github.com/acme/tool/issues/9\nissue: https://github.com/acme/tool/issues/10',
  });
  assert.equal(await hunt(target.context, 2), true);
  const urls = target.events
    .filter((record) => record.kind === 'hunt.issue')
    .map((record) => record.url);
  assert.deepEqual(urls, [
    'https://github.com/acme/tool/issues/9',
    'https://github.com/acme/tool/issues/10',
  ]);
});

test('a user whose hunt files nothing sees one hunt.issue event with none in the run log', async (t) => {
  const target = await harness(t, { hunterText: 'Nothing found.\nissue: none' });
  assert.equal(await hunt(target.context, 2), false);
  const urls = target.events
    .filter((record) => record.kind === 'hunt.issue')
    .map((record) => record.url);
  assert.deepEqual(urls, ['none']);
});

test('a user whose hunt reply has a bare issue: line with a url on the next line sees one hunt.issue event with none, so the watch backs off', async (t) => {
  const target = await harness(t, {
    hunterText: 'Duplicate exists, see\nissue:\nhttps://github.com/acme/tool/issues/12\n',
  });
  assert.equal(await hunt(target.context, 1), false);
  const urls = target.events
    .filter((record) => record.kind === 'hunt.issue')
    .map((record) => record.url);
  assert.deepEqual(urls, ['none']);
});

test('a user who hunts sees the hunter told to search and file issues in the repository of the configured remote', async (t) => {
  const target = await harness(t);
  await hunt(target.context, 1);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /gh issue list --repo acme\/tool --state all --search/);
  assert.match(prompt, /gh issue create --repo acme\/tool --label "status:todo"/);
});

test('a user whose remote points to a fork sees the hunter told to search and file issues in the fork', async (t) => {
  const target = await harness(t);
  target.context.repo.owner = 'me';
  target.context.repo.name = 'fork';
  await hunt(target.context, 1);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /gh issue list --repo me\/fork /);
  assert.match(prompt, /gh issue create --repo me\/fork /);
  assert.doesNotMatch(prompt, /acme\/tool/);
});

test('a user whose hunter reports an issue of another repository sees the hunt count it as nothing filed, so the watch backs off', async (t) => {
  const target = await harness(t, {
    hunterText:
      'Filed.\nissue: https://github.com/upstream/tool/issues/9\nissue: https://github.com/acme/tool-x/issues/3\nissue: https://github.com/acme/tool/pull/4',
  });
  assert.equal(await hunter(target.context).hunt(1), false);
  const urls = target.events
    .filter((record) => record.kind === 'hunt.issue')
    .map((record) => record.url);
  assert.deepEqual(urls, ['none']);
});

test('a user whose hunter reports issues of the configured repository and of another one sees only the issue of the configured repository counted', async (t) => {
  const target = await harness(t, {
    hunterText:
      'Filed.\nissue: https://github.com/upstream/tool/issues/9\nissue: https://github.com/Acme/Tool/issues/10',
  });
  assert.equal(await hunt(target.context, 2), true);
  const urls = target.events
    .filter((record) => record.kind === 'hunt.issue')
    .map((record) => record.url);
  assert.deepEqual(urls, ['https://github.com/Acme/Tool/issues/10']);
});

test('a user whose hunter fails sees a hunt.error event', async (t) => {
  const target = await harness(t, { fail: 'runAgent' });
  await assert.rejects(hunt(target.context, 1), /the port broke/);
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

test('a user whose hunter left a branch checked out gets the next hunt on a detached HEAD at the remote base, with the branch kept', async () => {
  const { repo, other } = await clones();
  const path = await huntWorktree(repo, 'main', 'origin');
  await git(path, 'checkout', '-q', '-b', '3');
  const kept = await commit(path, 'kept.txt');
  const pushed = await commit(other, 'b.txt');
  await git(other, 'push', '-q', 'origin', 'main');
  assert.equal(await huntWorktree(repo, 'main', 'origin'), path);
  assert.equal(await revision(path), pushed);
  assert.equal(await git(path, 'branch', '--show-current'), '');
  assert.equal(await git(repo.root, 'rev-parse', '3'), kept);
});

test('a user whose hunter left a detached HEAD at another commit gets the next hunt at the remote base', async () => {
  const { repo } = await clones();
  const path = await huntWorktree(repo, 'main', 'origin');
  const base = await revision(path);
  await commit(path, 'other.txt');
  assert.equal(await huntWorktree(repo, 'main', 'origin'), path);
  assert.equal(await revision(path), base);
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
    (await watched.ready(new Set(), new Set())).map((issue) => issue.number),
    [7],
  );
  assert.deepEqual(asked, [['status:todo']]);
});

test('a user who hunts sees the hunter count an issue blocked only by running or claimable issues of the same repository, and not one with a blocker that cannot move', async (t) => {
  const labelled = (number: number, labels: string[]) => ({ ...ISSUE, number, labels });
  const open = [
    labelled(7, ['status:todo']),
    labelled(8, ['status:todo']),
    labelled(9, ['status:todo']),
    labelled(10, ['status:todo']),
    labelled(11, ['status:todo']),
    labelled(12, ['status:todo']),
    labelled(13, ['status:todo']),
    labelled(14, ['status:todo']),
    labelled(20, ['status:todo', 'status:in-progress']),
    labelled(21, ['status:todo', 'status:needs-human']),
    labelled(22, ['status:todo', 'status:blocked']),
    labelled(23, ['status:todo', 'status:done']),
  ];
  const blockers: Record<number, string[]> = {
    7: ['#20'],
    8: ['#9', '#20'],
    10: ['#21'],
    11: ['#22'],
    12: ['#23'],
    13: ['#30'],
    14: ['acme/other#9'],
    9: [],
  };
  const target = await harness(t, { open });
  target.context.ports.openBlockers = async (_repo, number) => blockers[number] ?? ['#9', '#30'];
  assert.deepEqual(
    (await hunter(target.context).ready(new Set([20]), new Set())).map((issue) => issue.number),
    [7, 8, 9],
  );
});

test('a user who hunts sees the hunter leave out an issue that failed earlier in the run, and an issue blocked only by it', async (t) => {
  const open = [7, 8, 9].map((number) => ({ ...ISSUE, number }));
  const target = await harness(t, { open });
  target.context.ports.openBlockers = async (_repo, number) => (number === 8 ? ['#7'] : []);
  assert.deepEqual(
    (await hunter(target.context).ready(new Set(), new Set([7]))).map((issue) => issue.number),
    [9],
  );
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
  const hunting = watched.hunt(1);
  assert.equal(watched.busy(), true);
  await hunting;
  assert.equal(watched.busy(), false);
});

test('a user whose hunt fails sees the hunter report the failure so the watch backs off', async (t) => {
  const target = await harness(t, { fail: 'runAgent' });
  assert.equal(await hunter(target.context).hunt(1), false);
});

test('a user whose hunt files an issue sees the hunter report the success', async (t) => {
  const target = await harness(t, {
    hunterText: 'Found it.\nissue: https://github.com/acme/tool/issues/9',
  });
  assert.equal(await hunter(target.context).hunt(1), true);
});

test('a user whose hunt replies issue: none sees the hunter report it so the watch backs off', async (t) => {
  const target = await harness(t, { hunterText: 'Nothing found.\nissue: none' });
  assert.equal(await hunter(target.context).hunt(1), false);
});

test('a user whose hunt reply has no issue line sees the hunter report it so the watch backs off', async (t) => {
  const target = await harness(t, { hunterText: 'Nothing found.' });
  assert.equal(await hunter(target.context).hunt(1), false);
});

async function labelledHunt(t: TestContext, name: string, labels: string, create = '') {
  const dir = await tempDir();
  const file = join(dir, 'labels');
  await writeFile(file, labels);
  const refusal = create === '' ? '' : `echo "${create}" >&2; exit 1;`;
  await installGh(
    t,
    dir,
    `#!/bin/sh
case "$1 $2" in
  "label list") printf '['; sed 's/.*/{"name":"&"}/' "${file}" | paste -sd, -; printf ']' ;;
  "label create")
    ${refusal}
    if grep -qix -- "$3" "${file}"; then echo "label with name $3 already exists" >&2; exit 1; fi
    echo "$3" >> "${file}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  const target = await harness(t, {
    hunterText: `Found it.\nissue: https://github.com/acme/${name}/issues/9`,
  });
  target.context.repo.name = name;
  target.context.ports.ensureLabel = ensureLabel;
  return { target, file };
}

test('a user whose repository holds the ready and hunt labels in another case sees the hunter run and file an issue, with no hunt.error event', async (t) => {
  const { target, file } = await labelledHunt(t, 'label-case', 'Status:Todo\nSource:Hunt\n');
  assert.equal(await hunter(target.context).hunt(1), true);
  assert.equal(target.prompts.length, 1);
  assert.ok(!target.events.some((record) => record.kind === 'hunt.error'));
  assert.equal(await readFile(file, 'utf8'), 'Status:Todo\nSource:Hunt\n');
});

test('a user whose hunt label was created by someone else after the harness read the labels sees the next hunt run, with no hunt.error event', async (t) => {
  const { target, file } = await labelledHunt(t, 'label-stale', 'status:todo\n');
  await ensureLabel(target.context.repo, 'status:todo');
  await writeFile(file, 'status:todo\nsource:hunt\n');
  assert.equal(await hunter(target.context).hunt(1), true);
  assert.equal(await hunter(target.context).hunt(1), true);
  assert.equal(target.prompts.length, 2);
  assert.ok(!target.events.some((record) => record.kind === 'hunt.error'));
});

test('a user whose hunt label create fails for another reason sees the hunt fail with a hunt.error event and no hunter run', async (t) => {
  const { target } = await labelledHunt(t, 'label-denied', '', 'permission denied');
  assert.equal(await hunter(target.context).hunt(1), false);
  assert.equal(target.prompts.length, 0);
  const error = target.events.find((record) => record.kind === 'hunt.error');
  assert.match(String(error?.error), /permission denied/);
});
