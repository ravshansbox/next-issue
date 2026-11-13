import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setCommandObserver } from '../src/exec.mts';
import {
  commentOnIssue,
  defaultBranch,
  canWrite,
  issueComments,
  openBlockers,
  openIssues,
  reopenIssue,
  threadComments,
  viewIssue,
} from '../src/github.mts';
import { setLabel } from '../src/labels.mts';
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

test('openBlockers lists the open blockers and names those of another repository', async (t) => {
  const dir = await tempDir();
  const response = JSON.stringify([
    { number: 3, state: 'open', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 4, state: 'closed', repository_url: 'https://api.github.com/repos/acme/tool' },
    { number: 9, state: 'open', repository_url: 'https://api.github.com/repos/acme/other' },
  ]);
  await writeFile(join(dir, 'response.json'), response);
  const script = `#!/bin/sh
[ "$1 $2 $3" = "api --paginate repos/acme/tool/issues/7/dependencies/blocked_by" ] || { echo "unexpected: $*" >&2; exit 1; }
jq -r "$5" "${join(dir, 'response.json')}"
`;
  await installGh(t, dir, script);
  assert.deepEqual(await openBlockers({ owner: 'acme', name: 'tool', root: dir }, 7), [
    '#3',
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
