import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setCommandObserver } from '../src/exec.mts';
import {
  commentOnIssue,
  commentOnPr,
  createPr,
  defaultBranch,
  canWrite,
  findPr,
  issueComments,
  markPrReady,
  mergeCommit,
  mergePr,
  openBlockers,
  openIssues,
  prConflicts,
  prMerged,
  prNumber,
  reopenIssue,
  threadComments,
  viewIssue,
} from '../src/github.mts';
import { failedCheckLogs, waitForChecks } from '../src/checks.mts';
import { setLabel } from '../src/labels.mts';

async function flakyGh(t: TestContext, failures: number, error: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const calls = join(dir, 'calls');
  await writeFile(calls, '');
  const script = `#!/bin/sh
echo "$1 $2" >> "${calls}"
case "$1 $2" in
  "label list") echo '[{"name":"status:todo"}]' ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit"|"pr comment"|"issue comment")
    cat > /dev/null
    if [ "$(grep -c -- "$1 $2" "${calls}")" -le ${failures} ]; then echo '${error}' >&2; exit 1; fi ;;
  "pr list")
    if [ "$(grep -c -- "$1 $2" "${calls}")" -le ${failures} ]; then echo '${error}' >&2; exit 1; fi
    echo '[{"number":5}]' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
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

test('commentOnPr posts once and fails when the network fails, so no comment is doubled', async (t) => {
  const dir = await flakyGh(t, 1, NETWORK_FAULT);
  await assert.rejects(
    commentOnPr({ owner: 'acme', name: 'comment', root: dir }, 2, 'hi'),
    /unexpected EOF/,
  );
  assert.equal(await callsOf(dir, 'pr comment'), 1);
});

test('commentOnIssue posts once and fails when the network fails, so no comment is doubled', async (t) => {
  const dir = await flakyGh(t, 1, NETWORK_FAULT);
  await assert.rejects(
    commentOnIssue({ owner: 'acme', name: 'comment', root: dir }, 2, 'hi'),
    /unexpected EOF/,
  );
  assert.equal(await callsOf(dir, 'issue comment'), 1);
});

test('findPr looks up the pull request again and finds it when the network fails once', async (t) => {
  const dir = await flakyGh(t, 1, NETWORK_FAULT);
  assert.equal(await findPr({ owner: 'acme', name: 'flaky', root: dir }, 'issue-1'), 5);
  assert.equal(await callsOf(dir, 'pr list'), 2);
});

test('findPr reports the gh error when the lookup fails for a reason other than the network', async (t) => {
  const dir = await flakyGh(t, 1, 'HTTP 401: Bad credentials');
  await assert.rejects(
    findPr({ owner: 'acme', name: 'denied', root: dir }, 'issue-1'),
    /Bad credentials/,
  );
  assert.equal(await callsOf(dir, 'pr list'), 1);
});

test('prNumber reads the number from the pull request URL', () => {
  assert.equal(prNumber('https://github.com/acme/tool/pull/42\n'), 42);
  assert.equal(prNumber('https://github.example.com/acme/tool/pull/7'), 7);
  assert.equal(prNumber('no url here'), undefined);
});

async function fakeChecksGh(t: TestContext, runView: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const checks =
    '[{"name":"build","bucket":"fail","link":"https://github.com/acme/tool/actions/runs/7","description":"the job failed"}]';
  const script = `#!/bin/sh
case "$1 $2" in
  "pr checks") echo '${checks}' ;;
  "run view") ${runView} ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

test('failedCheckLogs gives the job logs when the read works', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "boom"');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /boom/);
});

test('failedCheckLogs tells the fixer when the log read fails', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "gone" >&2; exit 3');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /## build\nthe job failed/);
  assert.match(report, /The log read failed with code 3\. gone/);
});

test('failedCheckLogs keeps the partial logs when the read fails', async (t) => {
  const dir = await fakeChecksGh(t, 'echo "boom"; echo "gone" >&2; exit 3');
  const report = await failedCheckLogs({ owner: 'acme', name: 'tool', root: dir }, 1, 1000);
  assert.match(report, /boom\nThe log read failed with code 3\. gone/);
});

async function fakeWatchGh(t: TestContext, bucket: string, watches: number[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const checks = `[{"name":"build","bucket":"${bucket}","link":"","description":""}]`;
  await writeFile(join(dir, 'watches'), watches.join('\n') + '\n');
  const script = `#!/bin/sh
case "$1 $2 $4" in
  "pr checks --watch")
    code=$(head -n 1 "${join(dir, 'watches')}")
    tail -n +2 "${join(dir, 'watches')}" > "${join(dir, 'rest')}"; mv "${join(dir, 'rest')}" "${join(dir, 'watches')}"
    [ "$code" = 0 ] || echo "error connecting to api.github.com" >&2
    exit "$code" ;;
  "pr checks --json") echo '${checks}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

const PR_WAIT = { intervalSeconds: 0, graceMs: 0, timeoutMs: 10_000, show: false };

test('waitForChecks reports a failure when the watch fails and a check is in the fail bucket', async (t) => {
  const dir = await fakeWatchGh(t, 'fail', [1]);
  assert.equal(await waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT), 'fail');
});

test('waitForChecks retries the watch when gh fails but no check failed', async (t) => {
  const dir = await fakeWatchGh(t, 'pending', [1, 0]);
  assert.equal(await waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT), 'pass');
});

test('waitForChecks throws the gh error when the watch keeps failing and no check failed', async (t) => {
  const dir = await fakeWatchGh(t, 'pending', [1, 1, 1]);
  await assert.rejects(
    waitForChecks({ owner: 'acme', name: 'tool', root: dir }, 1, PR_WAIT),
    /no check failed: error connecting to api\.github\.com/,
  );
});

async function fakePrGh(t: TestContext, pr: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const checks =
    '[{"name":"build","bucket":"fail","link":"https://github.com/acme/tool/actions/runs/7","description":""}]';
  const script = `#!/bin/sh
case "$1 $2 $3" in
  "pr view ${pr}") echo abc ;;
  "pr checks ${pr}") [ "$4" = "--watch" ] && exit 1; echo '${checks}' ;;
  "run view"*) echo boom ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

test('the worker reads the checks of a pull request by its number when the branch name is also a number', async (t) => {
  const dir = await fakePrGh(t, 128);
  const repo = { owner: 'acme', name: 'tool', root: dir };
  assert.equal(await waitForChecks(repo, 128, { ...PR_WAIT, head: 'abc' }), 'fail');
  assert.match(await failedCheckLogs(repo, 128, 1000), /boom/);
});

test('openBlockers lists the open blockers and names those of another repository', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
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
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  assert.deepEqual(await openBlockers({ owner: 'acme', name: 'tool', root: dir }, 7), [
    '#3',
    'acme/other#9',
  ]);
});

async function fakeMergeGh(t: TestContext, views: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const calls = join(dir, 'calls');
  await writeFile(calls, '');
  const cases = views.map((view, index) => `  ${index + 1}) echo '${view}' ;;`).join('\n');
  const script = `#!/bin/sh
echo "$1 $2" >> "${calls}"
case "$(grep -c . "${calls}")" in
${cases}
  *) echo '${views.at(-1)}' ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

const MERGE_OPTIONS = { intervalSeconds: 10, timeoutMs: 60_000 };
const QUEUED = '{"state":"OPEN","mergeCommit":null}';

test('mergeCommit waits for a queued merge and gives the merge commit once the pull request is merged', async (t) => {
  const dir = await fakeMergeGh(t, [
    QUEUED,
    QUEUED,
    '{"state":"MERGED","mergeCommit":{"oid":"abc123"}}',
  ]);
  const repo = { owner: 'acme', name: 'queue', root: dir };
  assert.equal(await mergeCommit(repo, 5, MERGE_OPTIONS, fakeClock()), 'abc123');
  assert.equal(await callsOf(dir, 'pr view'), 3);
});

test('mergeCommit gives no merge commit when the queued merge does not finish in time', async (t) => {
  const dir = await fakeMergeGh(t, [QUEUED]);
  const repo = { owner: 'acme', name: 'slow', root: dir };
  assert.equal(await mergeCommit(repo, 5, MERGE_OPTIONS, fakeClock()), undefined);
});

test('mergeCommit gives no merge commit when the pull request closes without a merge', async (t) => {
  const dir = await fakeMergeGh(t, ['{"state":"CLOSED","mergeCommit":null}']);
  const repo = { owner: 'acme', name: 'closed', root: dir };
  assert.equal(await mergeCommit(repo, 5, MERGE_OPTIONS, fakeClock()), undefined);
  assert.equal(await callsOf(dir, 'pr view'), 1);
});

test('prConflicts waits while GitHub still works out mergeability and reports the conflict it then finds', async (t) => {
  const dir = await fakeMergeGh(t, ['UNKNOWN', 'UNKNOWN', 'CONFLICTING']);
  const repo = { owner: 'acme', name: 'unknown', root: dir };
  assert.equal(await prConflicts(repo, 5, MERGE_OPTIONS, fakeClock()), true);
  assert.equal(await callsOf(dir, 'pr view'), 3);
});

test('prConflicts reports no conflict when mergeability stays unknown past the timeout', async (t) => {
  const dir = await fakeMergeGh(t, ['UNKNOWN']);
  const repo = { owner: 'acme', name: 'stuck', root: dir };
  assert.equal(await prConflicts(repo, 5, MERGE_OPTIONS, fakeClock()), false);
});

test('a user with a ready issue newer than the issue limit gets it listed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const script = `#!/bin/sh
case "$*" in
  *'label:"status:todo","status:in-progress"'*)
    echo '[{"number":150,"title":"ready","body":"","createdAt":"2026-02-01T00:00:00Z","labels":[{"name":"status:todo"}]}]' ;;
  *) echo '[{"number":1,"title":"old","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const repo = { owner: 'acme', name: 'many', root: dir };
  const issues = await openIssues(repo, 1, ['status:todo', 'status:in-progress']);
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [150],
  );
});

async function fakeAnyGh(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const script = `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "issue view") echo '{"number":7,"title":"t","body":"","createdAt":"2026-01-01T00:00:00Z","labels":[],"comments":[],"state":"OPEN"}' ;;
  "pr list") echo '[{"number":42}]' ;;
  "pr create") echo https://github.com/acme/tool/pull/42 ;;
  "pr view") echo MERGED ;;
  "pr ready"|"pr merge"|"issue reopen") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(dir, 'gh'), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return dir;
}

test('the worker passes gh the repository and the issue or pull request number it acts on', async (t) => {
  const dir = await fakeAnyGh(t);
  const seen: string[][] = [];
  setCommandObserver((record) => seen.push(record.args));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'tool', root: dir };
  await defaultBranch(repo);
  await viewIssue(repo, 7);
  await issueComments(repo, 7);
  await findPr(repo, '7');
  await createPr(repo, '7', 'main', 'fix: x', 'Closes #7', true);
  await markPrReady(repo, 42);
  await mergePr(repo, 42);
  await prMerged(repo, 42);
  await prConflicts(repo, 42, MERGE_OPTIONS);
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
    ['pr', 'list', '--head', '7', '--state', 'open', '--json', 'number', '--repo', 'acme/tool'],
    [
      'pr',
      'create',
      '--head',
      '7',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--body',
      'Closes #7',
      '--draft',
      '--repo',
      'acme/tool',
    ],
    ['pr', 'ready', '42', '--repo', 'acme/tool'],
    ['pr', 'merge', '42', '--squash', '--delete-branch', '--repo', 'acme/tool'],
    ['pr', 'view', '42', '--json', 'state', '--jq', '.state', '--repo', 'acme/tool'],
    ['pr', 'view', '42', '--json', 'mergeable', '--jq', '.mergeable', '--repo', 'acme/tool'],
    ['issue', 'reopen', '7', '--repo', 'acme/tool'],
  ]);
});

async function fakeApiGh(t: TestContext, script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  await writeFile(join(dir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
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
