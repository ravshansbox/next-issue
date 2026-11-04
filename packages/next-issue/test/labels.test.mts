import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type CommandRecord, setCommandObserver } from '../src/exec.mts';
import { labelArgs, setLabel } from '../src/labels.mts';
import { installGh } from './fake-gh.mts';

const MANAGED = ['status:todo', 'status:in-progress', 'status:in-review', 'status:done'];

test('labelArgs adds the new label', () => {
  assert.deepEqual(labelArgs('status:in-review', MANAGED, []), ['--add-label', 'status:in-review']);
});

test('labelArgs removes only a label that is present', () => {
  assert.deepEqual(labelArgs('status:in-review', MANAGED, ['status:todo', 'type: bug']), [
    '--add-label',
    'status:in-review',
    '--remove-label',
    'status:todo',
  ]);
});

test('labelArgs never removes the label it adds', () => {
  assert.deepEqual(labelArgs('status:done', MANAGED, ['status:done', 'status:in-review']), [
    '--add-label',
    'status:done',
    '--remove-label',
    'status:in-review',
  ]);
});

async function fakeGh(t: TestContext, listed = '[{"name":"status:todo"}]'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const labels = join(dir, 'labels');
  await writeFile(labels, 'status:todo\n');
  const script = `#!/bin/sh
case "$1 $2" in
  "label list") echo '${listed}' ;;
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

test('setLabel creates a missing label once and records no failed command', async (t) => {
  const dir = await fakeGh(t);
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'labels', root: dir };
  await setLabel(repo, 'issue', 1, 'status:todo', []);
  await setLabel(repo, 'issue', 1, 'status:new', []);
  await setLabel(repo, 'pr', 2, 'status:new', []);
  assert.deepEqual(
    seen.filter((record) => record.code !== 0),
    [],
  );
  assert.equal(await readFile(join(dir, 'labels'), 'utf8'), 'status:todo\nstatus:new\n');
});

test('setLabel tries the create again when it failed', async (t) => {
  const dir = await fakeGh(t, '[]');
  const seen: CommandRecord[] = [];
  setCommandObserver((record) => seen.push(record));
  t.after(() => setCommandObserver(() => undefined));
  const repo = { owner: 'acme', name: 'retry', root: dir };
  await setLabel(repo, 'issue', 1, 'status:todo', []);
  await setLabel(repo, 'issue', 1, 'status:todo', []);
  const creates = seen.filter(
    (record) => record.args[0] === 'label' && record.args[1] === 'create',
  );
  assert.equal(creates.length, 2);
});

test('setLabel creates a label again when a person deleted it after the worker read the labels', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const labels = join(dir, 'labels');
  await writeFile(labels, 'status:todo\n');
  const script = `#!/bin/sh
case "$1 $2" in
  "label list") printf '['; sed 's/.*/{"name":"&"}/' "${labels}" | paste -sd, -; printf ']' ;;
  "label create") echo "$3" >> "${labels}" ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit") grep -qx -- "$5" "${labels}" || { echo "'$5' not found" >&2; exit 1; } ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'deleted', root: dir };
  await setLabel(repo, 'issue', 1, 'status:todo', []);
  await writeFile(labels, '');
  await setLabel(repo, 'issue', 1, 'status:todo', []);
  assert.equal(await readFile(labels, 'utf8'), 'status:todo\n');
});

test('setLabel shows the create error when the label create fails twice', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'next-issue-'));
  const script = `#!/bin/sh
case "$1 $2" in
  "label list") echo '[]' ;;
  "label create") echo "permission denied" >&2; exit 1 ;;
  "issue view") echo '{"labels":[]}' ;;
  "issue edit") echo "'$5' not found" >&2; exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;
  await installGh(t, dir, script);
  const repo = { owner: 'acme', name: 'forbidden', root: dir };
  await assert.rejects(
    setLabel(repo, 'issue', 1, 'status:todo', []),
    /label create .*permission denied/,
  );
});
