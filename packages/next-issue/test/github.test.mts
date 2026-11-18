import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setCommandObserver } from '../src/shared/exec.mts';
import {
  closeIssue,
  commentOnIssue,
  defaultBranch,
  canWrite,
  issueComments,
  issueEditors,
  openBlockers,
  repositorySlug,
  openIssues,
  reopenIssue,
  threadComments,
  viewIssue,
} from '../src/shared/github.mts';
import { setLabel } from '../src/shared/labels.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

async function flakyGh(t: TestContext, failures: number, error: string): Promise<string> {
  const dir = await tempDir();
  const calls = join(dir, 'calls');
  await writeFile(calls, '');
  const script = `#!/bin/sh
echo "$1 $2" >> "${calls}"
case "$1 $2" in
  "label list") echo '[{"name":"status:todo"}]' ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit"|"issue comment")
    cat > /dev/null
    if [ "$(grep -c -- "$1 $2" "${calls}")" -le ${failures} ]; then echo '${error}' >&2; exit 1; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

async function callsOf(dir: string, call: string): Promise<number> {
  const lines = (await readFile(join(dir, 'calls'), 'utf8')).split('\n');
  return lines.filter((line) => line === call).length;
}

const NETWORK_FAULT = 'Post "https://api.github.com/graphql": unexpected EOF';

test('setLabel tries the label edit again and succeeds when the network fails once', async (t) => {
  const dir = await flakyGh(t, 1, NETWORK_FAULT);
  await setLabel({ owner: 'acme', name: 'flaky', root: dir }, 'issue', 1, 'status:todo', []);
  assert.equal(await callsOf(dir, 'issue edit'), 2);
});

test('setLabel gives up after three tries when the network keeps failing', async (t) => {
  const dir = await flakyGh(t, 3, NETWORK_FAULT);
  await assert.rejects(
    setLabel({ owner: 'acme', name: 'down', root: dir }, 'issue', 1, 'status:todo', []),
    /unexpected EOF/,
  );
  assert.equal(await callsOf(dir, 'issue edit'), 3);
});

test('setLabel fails at once when gh fails for a reason other than the network', async (t) => {
  const dir = await flakyGh(t, 1, 'HTTP 404: Not Found');
  await assert.rejects(
    setLabel({ owner: 'acme', name: 'missing', root: dir }, 'issue', 1, 'status:todo', []),
    /Not Found/,
  );
  assert.equal(await callsOf(dir, 'issue edit'), 1);
});

test('commentOnIssue posts once and fails when the network fails, so no comment is doubled', async (t) => {
  const dir = await flakyGh(t, 1, NETWORK_FAULT);
  await assert.rejects(
    commentOnIssue({ owner: 'acme', name: 'comment', root: dir }, 2, 'hi'),
    /unexpected EOF/,
  );
  assert.equal(await callsOf(dir, 'issue comment'), 1);
});

test('a user whose remote is on a GitHub Enterprise host sees every gh call name that host', async (t) => {
  const dir = await tempDir();
  const calls = join(dir, 'calls');
  await writeFile(calls, '');
  const script = `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"trunk"}}' ;;
  "api --hostname") echo 'acme/tool' ;;
  "issue close"|"issue reopen") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { host: 'github.example.com', owner: 'acme', name: 'tool', root: dir };
  assert.equal(await defaultBranch(repo), 'trunk');
  assert.equal(await repositorySlug(repo), 'acme/tool');
  await closeIssue(repo, 4);
  await reopenIssue(repo, 4);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [
    'repo view github.example.com/acme/tool --json defaultBranchRef',
    'api --hostname github.example.com repos/acme/tool --jq .full_name',
    'issue close 4 --reason completed --repo github.example.com/acme/tool',
    'issue reopen 4 --repo github.example.com/acme/tool',
  ]);
});

test('openBlockers lists the open blockers and names those of another repository', async (t) => {
  const dir = await tempDir();
  const response = JSON.stringify([
    { number: 3, state: 'open', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 4, state: 'closed', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 9, state: 'open', repository_url: 'https://api.github.com/repos/acme/other' },
  ]);
  await writeFile(join(dir, 'response.json'), response);
  await writeFile(
    join(dir, 'issue.json'),
    JSON.stringify({ number: 7, repository_url: 'https://api.github.com/repos/acme/tool' }),
  );
  const script = `#!/bin/sh
case "$*" in
  "api --paginate repos/acme/tool/issues/7/dependencies/blocked_by "*) jq -r "$5" "${join(dir, 'response.json')}" ;;
  "api repos/acme/tool/issues/7 "*) jq -r "$4" "${join(dir, 'issue.json')}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  assert.deepEqual(await openBlockers({ owner: 'acme', name: 'tool', root: dir }, 7), [
    '#3',
    'acme/other#9',
  ]);
});

test('openBlockers gives #<n> for a blocker of the same repository when the remote url differs in case', async (t) => {
  const dir = await tempDir();
  const response = JSON.stringify([
    { number: 12, state: 'open', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 9, state: 'open', repository_url: 'https://api.github.com/repos/acme/other' },
  ]);
  await writeFile(join(dir, 'response.json'), response);
  await writeFile(
    join(dir, 'issue.json'),
    JSON.stringify({ number: 7, repository_url: 'https://api.github.com/repos/acme/tool' }),
  );
  const script = `#!/bin/sh
case "$*" in
  "api --paginate repos/Acme/Tool/issues/7/dependencies/blocked_by "*) jq -r "$5" "${join(dir, 'response.json')}" ;;
  "api repos/Acme/Tool/issues/7 "*) jq -r "$4" "${join(dir, 'issue.json')}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  assert.deepEqual(await openBlockers({ owner: 'Acme', name: 'Tool', root: dir }, 7), [
    '#12',
    'acme/other#9',
  ]);
});

test('openBlockers gives #<n> for a blocker of the same repository when the remote url holds its old name', async (t) => {
  const dir = await tempDir();
  const response = JSON.stringify([
    { number: 12, state: 'open', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 9, state: 'open', repository_url: 'https://api.github.com/repos/acme/other' },
  ]);
  await writeFile(join(dir, 'response.json'), response);
  await writeFile(
    join(dir, 'issue.json'),
    JSON.stringify({ number: 7, repository_url: 'https://api.github.com/repos/acme/tool' }),
  );
  const script = `#!/bin/sh
case "$*" in
  "api --paginate repos/old/name/issues/7/dependencies/blocked_by "*) jq -r "$5" "${join(dir, 'response.json')}" ;;
  "api repos/old/name/issues/7 "*) jq -r "$4" "${join(dir, 'issue.json')}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  assert.deepEqual(await openBlockers({ owner: 'old', name: 'name', root: dir }, 7), [
    '#12',
    'acme/other#9',
  ]);
});

test('a user with a ready issue newer than the issue limit gets it listed', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$*" in
  *'label:"status:todo","status:in-progress"'*)
    echo '[{"number":150,"title":"ready","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *) echo '[{"number":1,"title":"old","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'many', root: dir };
  const issues = await openIssues(repo, 1, ['status:todo', 'status:in-progress']);
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [150],
  );
});

test('a user who leaves labels out of the issue list gets only the issues without them', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$*" in
  *'label:"status:todo" -label:"status:needs-human" -label:"status:blocked"'*)
    echo '[{"number":150,"title":"ready","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *) echo '[{"number":1,"title":"given up","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'held', root: dir };
  const issues = await openIssues(
    repo,
    1,
    ['status:todo'],
    ['status:needs-human', 'status:blocked'],
  );
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [150],
  );
});

test('a user who asks for issues with every one of some labels gets only the issues with all of them', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$*" in
  *'label:"status:needs-human" label:"status:todo" -label:"status:blocked"'*)
    echo '[{"number":150,"title":"waiting","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *) echo '[{"number":1,"title":"not ready","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'waiting', root: dir };
  const issues = await openIssues(
    repo,
    1,
    ['status:needs-human'],
    ['status:blocked'],
    ['status:todo'],
  );
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [150],
  );
});

test('a user who asks for blocked or unblocked issues gets only those issues listed', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$*" in
  *'label:"status:todo" -is:blocked'*)
    echo '[{"number":150,"title":"free","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *'label:"status:todo" is:blocked'*)
    echo '[{"number":2,"title":"blocked","body":"","createdAt":"2026-01-02T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *) echo '[{"number":1,"title":"any","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'blocked', root: dir };
  const numbers = async (blocked: boolean) =>
    (await openIssues(repo, 1, ['status:todo'], [], [], blocked)).map((issue) => issue.number);
  assert.deepEqual(
    { unblocked: await numbers(false), blocked: await numbers(true) },
    { unblocked: [150], blocked: [2] },
  );
});

test('a user whose ready label holds a double quote gets its issues listed', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$*" in
  *'label:"say \\"hi\\""'*)
    echo '[{"number":4,"title":"quoted","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"say \\"hi\\""}]}]' ;;
  *) echo '[]' ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'quoted', root: dir };
  const issues = await openIssues(repo, 10, ['say "hi"']);
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [4],
  );
});

async function fakeAnyGh(t: TestContext): Promise<string> {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue view") echo '{"number":7,"title":"t","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[],"comments":[],"state":"OPEN"}' ;;
  "issue reopen") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

test('the worker passes gh the repository and the issue number it acts on', async (t) => {
  const dir = await fakeAnyGh(t);
  const seen: string[][] = [];
  setCommandObserver((record) => seen.push(record.args));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'tool', root: dir };
  await defaultBranch(repo);
  await viewIssue(repo, 7);
  await issueComments(repo, 7);
  await reopenIssue(repo, 7);
  assert.deepEqual(seen, [
    ['repo', 'view', 'acme/tool', '--json', 'defaultBranchRef'],
    [
      'issue',
      'view',
      '7',
      '--json',
      'number,title,body,createdAt,labels,state',
      '--repo',
      'acme/tool',
    ],
    ['issue', 'view', '7', '--json', 'comments', '--repo', 'acme/tool'],
    ['issue', 'reopen', '7', '--repo', 'acme/tool'],
  ]);
});

async function fakeApiGh(t: TestContext, script: string): Promise<string> {
  const dir = await tempDir();
  await installGh(t, dir, `#!/bin/sh\n${script}\n`);
  return dir;
}

test('threadComments reads the author, the body and the url of each comment of an issue or pull request', async (t) => {
  const dir = await fakeApiGh(
    t,
    `[ "$3" = "repos/acme/tool/issues/42/comments" ] || exit 1
printf '%s\\n' '["owner","line one\\nline two","https://github.com/acme/tool/issues/42#issuecomment-1"]' '["bot",null]'`,
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.deepEqual(await threadComments(repo, 42), [
    {
      author: 'owner',
      body: 'line one\nline two',
      url: 'https://github.com/acme/tool/issues/42#issuecomment-1',
    },
    { author: 'bot', body: '' },
  ]);
});

test('canWrite grants write access only to an admin or a writer', async (t) => {
  const dir = await fakeApiGh(
    t,
    `case "$2" in
  */admin/permission) echo admin ;;
  */writer/permission) echo write ;;
  */reader/permission) echo read ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac`,
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await canWrite(repo, 'admin'), true);
  assert.equal(await canWrite(repo, 'writer'), true);
  assert.equal(await canWrite(repo, 'reader'), false);
  assert.equal(await canWrite(repo, 'ghost'), false);
});

test('issueEditors gives the title and body and names the author for a title and body never changed, the last editor and renamer otherwise, and ghost for a deleted account', async (t) => {
  const dir = await fakeApiGh(
    t,
    `case "$*" in
  *"number=1 "*) echo '{"title":"T","body":"B","author":{"login":"stranger"},"editor":null,"lastEditedAt":null,"timelineItems":{"nodes":[]}}' ;;
  *"number=2 "*) echo '{"title":"T","body":"B","author":{"login":"stranger"},"editor":{"login":"owner"},"lastEditedAt":"2026-01-02T00:00:00Z","timelineItems":{"nodes":[{"actor":{"login":"admin"}}]}}' ;;
  *"number=3 "*) echo '{"title":"T","body":"B","author":null,"editor":null,"lastEditedAt":"2026-01-02T00:00:00Z","timelineItems":{"nodes":[{"actor":null}]}}' ;;
  *) exit 1 ;;
esac`,
  );
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.deepEqual(await issueEditors(repo, 1), {
    title: 'T',
    body: 'B',
    editors: { body: 'stranger', title: 'stranger' },
  });
  assert.deepEqual(await issueEditors(repo, 2), {
    title: 'T',
    body: 'B',
    editors: { body: 'owner', title: 'admin' },
  });
  assert.deepEqual(await issueEditors(repo, 3), {
    title: 'T',
    body: 'B',
    editors: { body: 'ghost', title: 'ghost' },
  });
});
