import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { hunt } from '../src/hunt.mts';
import { changes, harness, APPROVE, roles } from './harness.mts';

async function writeNotes(root: string, text: string): Promise<string> {
  const dir = join(root, '.next-issue');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'notes.md');
  await writeFile(path, text);
  return path;
}

test('every agent gets the shared notes of the repository in its prompt', async (t) => {
  const target = await harness(t, { verdicts: [changes('Rename it.'), APPROVE] });
  await writeNotes(target.context.repo.root, 'Run the tests with npm test.');
  await target.run();
  assert.deepEqual(roles(target), ['implementer', 'reviewer', 'fixer', 'reviewer']);
  for (const entry of target.prompts) {
    assert.match(entry.prompt, /## Shared notes\n[\s\S]*Run the tests with npm test\./);
  }
});

test('the implementer and the fixer are told where to add a short note and to keep only what still holds', async (t) => {
  const target = await harness(t, { verdicts: [changes('Rename it.'), APPROVE] });
  const path = await writeNotes(target.context.repo.root, 'Run the tests with npm test.');
  await target.run();
  for (const entry of target.prompts) {
    const told = entry.prompt.includes(`add a short note to ${path}`);
    assert.equal(told, entry.role !== 'reviewer', entry.role);
    assert.equal(/keep only what still holds/.test(entry.prompt), entry.role !== 'reviewer');
  }
});

test('a hunter gets the shared notes of the repository in its prompt and is not told to add a note', async (t) => {
  const target = await harness(t);
  const path = await writeNotes(target.context.repo.root, 'Run the tests with npm test.');
  await hunt(target.context, 1);
  const prompt = target.prompts[0]!.prompt;
  assert.match(prompt, /## Shared notes\n[\s\S]*Run the tests with npm test\./);
  assert.equal(prompt.includes(`add a short note to ${path}`), false);
  assert.doesNotMatch(prompt, /keep only what still holds/);
});

test('a hunter gets no shared notes and no mention of the notes file when the repository has no notes file', async (t) => {
  const target = await harness(t);
  await hunt(target.context, 1);
  assert.doesNotMatch(target.prompts[0]!.prompt, /Shared notes|notes\.md/);
});

test('an agent gets no shared notes when the repository has no notes file', async (t) => {
  const target = await harness(t);
  await target.run();
  const [implementer, reviewer] = target.prompts;
  assert.doesNotMatch(implementer!.prompt, /Shared notes/);
  assert.match(implementer!.prompt, /add a short note to .*notes\.md/);
  assert.doesNotMatch(reviewer!.prompt, /Shared notes|notes\.md/);
});
