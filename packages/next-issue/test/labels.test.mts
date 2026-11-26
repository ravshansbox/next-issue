import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type CommandRecord, setCommandObserver } from '../src/shared/exec.mts';
import { ensureLabel, setLabel, staleLabels } from '../src/shared/labels.mts';
import { installGh } from './fake-gh.mts';
import { tempDir } from './temp-dir.mts';

const MANAGED = ['status:todo', 'status:in-progress', 'status:in-review', 'status:done'];

test('the worker removes only a label that is present', () => {
  assert.deepEqual(staleLabels('status:in-review', MANAGED, ['status:todo', 'type: bug']), [
    'status:todo',
  ]);
});

test('the worker removes a present label held in another case by its own name', () => {
  assert.deepEqual(staleLabels('status:in-review', MANAGED, ['Status:Todo']), ['Status:Todo']);
});

test('the worker never removes the label it adds', () => {
  assert.deepEqual(staleLabels('status:done', MANAGED, ['status:done', 'status:in-review']), [
    'status:in-review',
  ]);
});

async function fakeGh(t: TestContext, listed = 'status:todo'): Promise<string> {
  const dir = await tempDir();
  const labels = join(dir, 'labels');
  await writeFile(labels, 'status:todo\n');
  const script = `#!/bin/sh
case "$1 $2" in
  "api --paginate") printf '${listed}' | jq -Rn '[inputs | {name: .}]' ;;
  "label create")
    if grep -qx -- "$3" "${labels}"; then echo "label with name $3 already exists" >&2; exit 1; fi
    echo "$3" >> "${labels}" ;;
  "issue view"|"pr view") echo '{"labels":[]}' ;;
  "issue edit"|"pr edit") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

test('the worker creates a missing label once and records no failed command', async (t) => {
  const dir = await fakeGh(t);
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'labels', root: dir };
  await setLabel(repo, 1, 'status:todo', []);
  await setLabel(repo, 1, 'status:new', []);
  assert.deepEqual(
    seen.filter((record) => record.code !== 0),
    [],
  );
  assert.equal(await readFile(join(dir, 'labels'), 'utf8'), 'status:todo\nstatus:new\n');
});

test('the worker tries a label create again when it failed', async (t) => {
  const dir = await fakeGh(t, '');
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'retry', root: dir };
  await setLabel(repo, 1, 'status:todo', []);
  await setLabel(repo, 1, 'status:todo', []);
  const creates = seen.filter(
    (record) => record.args[0] === 'label' && record.args[1] === 'create',
  );
  assert.equal(creates.length, 2);
});

test('the worker creates a label again when a person deleted it after the worker read the labels', async (t) => {
  const dir = await tempDir();
  const labels = join(dir, 'labels');
  await writeFile(labels, 'status:todo\n');
  const script = `#!/bin/sh
case "$1 $2" in
  "api --paginate") jq -Rn '[inputs | {name: .}]' "${labels}" ;;
  "label create") echo "$3" >> "${labels}" ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit") grep -qx -- "$5" "${labels}" || { echo "'$5' not found" >&2; exit 1; } ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'deleted', root: dir };
  await setLabel(repo, 1, 'status:todo', []);
  await writeFile(labels, '');
  await setLabel(repo, 1, 'status:todo', []);
  assert.equal(await readFile(labels, 'utf8'), 'status:todo\n');
});

test('the worker shows the create error when the label create fails twice', async (t) => {
  const dir = await tempDir();
  const script = `#!/bin/sh
case "$1 $2" in
  "api --paginate") echo '[]' ;;
  "label create") echo "permission denied" >&2; exit 1 ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit") echo "'$5' not found" >&2; exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'forbidden', root: dir };
  await assert.rejects(setLabel(repo, 1, 'status:todo', []), /label create .*permission denied/);
});

test('the worker creates a missing label and leaves a known one alone', async (t) => {
  const dir = await fakeGh(t);
  const repo = { owner: 'acme', name: 'ensure', root: dir };
  await ensureLabel(repo, 'status:todo');
  await ensureLabel(repo, 'source:hunt');
  assert.equal(await readFile(join(dir, 'labels'), 'utf8'), 'status:todo\nsource:hunt\n');
});

test('the worker accepts an existing label listed after the first 1,000 labels of the repository', async (t) => {
  const dir = await tempDir();
  const labels = join(dir, 'labels');
  const others = Array.from({ length: 1000 }, (_, index) => `other-${index}\n`).join('');
  await writeFile(labels, `${others}source:hunt\n`);
  const script = `#!/bin/sh
case "$1 $2" in
  "api --paginate") jq -Rn '[inputs | {name: .}]' "${labels}" ;;
  "label create")
    if grep -qx -- "$3" "${labels}"; then echo "label with name $3 already exists" >&2; exit 1; fi
    echo "$3" >> "${labels}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'many', root: dir };
  await ensureLabel(repo, 'source:hunt');
  assert.equal(await readFile(labels, 'utf8'), `${others}source:hunt\n`);
});

async function issueLabelsGh(t: TestContext, failAdd: boolean): Promise<string> {
  const dir = await tempDir();
  const held = join(dir, 'held');
  await writeFile(held, 'status:in-progress\n');
  const script = `#!/bin/sh
case "$1 $2" in
  "api --paginate") echo '[{"name":"status:in-progress"},{"name":"status:in-review"}]' ;;
  "issue view") jq -Rn '{labels: [inputs | {name: .}]}' "${held}" ;;
  "issue edit")
    shift 3
    add=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --remove-label) grep -vx -- "$2" "${held}" > "${held}.new"; mv "${held}.new" "${held}" ;;
        --add-label) add="$2" ;;
      esac
      shift 2
    done
    if [ -n "$add" ]; then
      if [ ${failAdd} = true ]; then echo 'HTTP 403: forbidden' >&2; exit 1; fi
      echo "$add" >> "${held}"
    fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  return dir;
}

test('the worker keeps the old status label on an issue when GitHub fails to add the new one', async (t) => {
  const dir = await issueLabelsGh(t, true);
  const repo = { owner: 'acme', name: 'add-fails', root: dir };
  await assert.rejects(setLabel(repo, 1, 'status:in-review', MANAGED), /forbidden/);
  assert.equal(await readFile(join(dir, 'held'), 'utf8'), 'status:in-progress\n');
});

test('the worker replaces the old status label on an issue with the new one', async (t) => {
  const dir = await issueLabelsGh(t, false);
  const repo = { owner: 'acme', name: 'add-works', root: dir };
  await setLabel(repo, 1, 'status:in-review', MANAGED);
  assert.equal(await readFile(join(dir, 'held'), 'utf8'), 'status:in-review\n');
});
