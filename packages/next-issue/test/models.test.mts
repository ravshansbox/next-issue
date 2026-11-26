import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { Config } from '../src/shared/config.mts';
import { hunt } from '../src/shared/hunt.mts';
import { APPROVE, harness } from './harness.mts';

async function modelsOf(
  t: TestContext,
  models: Config['models'],
): Promise<Record<string, unknown>> {
  const target = await harness(t, { config: { models }, verdicts: [APPROVE] });
  const used: Record<string, unknown> = {};
  const runAgent = target.context.ports.runAgent;
  target.context.ports.runAgent = async (recorder, request) => {
    used[request.name] = request.model;
    return runAgent(recorder, request);
  };
  await target.run();
  await hunt(target.context, 1);
  return used;
}

test('a user who sets a hunter model sees the hunter run with that model', async (t) => {
  const used = await modelsOf(t, { hunter: 'opus' });
  assert.equal(used.hunter, 'opus');
});

test('a user who sets models.default sees each agent without its own model run with the default model', async (t) => {
  const used = await modelsOf(t, { default: 'opus', reviewer: 'fable' });
  assert.deepEqual(used, {
    implementer: 'opus',
    reviewer: 'fable',
    hunter: 'opus',
  });
});

test('a user who sets no model sees each agent run with the default model of Claude Code', async (t) => {
  const used = await modelsOf(t, {});
  assert.deepEqual(used, { implementer: undefined, reviewer: undefined, hunter: undefined });
});
