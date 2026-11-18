import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/shared/agents.mts';
import { fakeClaude, text, toolUse } from './fake-claude.mts';

test('a test whose agent calls the fake Claude after its scripted replies run out fails with an unexpected agent call', async () => {
  const fake = await fakeClaude([toolUse('Bash', { command: 'ls' })]);
  await runAgent(fake.recorder, fake.request).catch(() => undefined);
  await assert.rejects(fake.close(), /unexpected agent call/);
});

test('a test whose agent uses every scripted reply of the fake Claude closes it without an error', async () => {
  const fake = await fakeClaude([text('done')]);
  await runAgent(fake.recorder, fake.request);
  await fake.close();
});
